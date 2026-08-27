import { hostname } from 'node:os';

// The worker is a standalone process, not part of the Next runtime, so nothing
// else loads `.env` for it. Must come before anything that reads process.env.
import 'dotenv/config';

import type { PageState } from '@prisma/client';

import { workerEnv } from '../lib/env';
import { WorkerApiClient, WorkerApiError, type ClaimedJobPayload } from './api-client';
import {
  LINKEDIN_FEED_URL,
  captureScreenshot,
  launchPersistentSession,
  runInteractiveLogin,
  type BrowserSession,
} from './browser';
import { AbortError, performConnect } from './actions/connect';
import { createLogger, type Logger } from './logger';
import { detectSessionState } from './page-state';

/**
 * The worker process.
 *
 * Runs standalone: it talks to the dashboard only over the authenticated HTTP
 * API and holds no database credentials. It processes at most one job at a time,
 * and only while it holds the exclusive run lease.
 *
 * Safety invariants this loop maintains:
 *  - It re-checks the control gate before every claim AND continuously while a
 *    job is in flight, so an emergency stop interrupts work already running.
 *  - Any detected CAPTCHA, security challenge, restriction or unrecognised page
 *    ends the run. It never retries such a state and never tries to get past it.
 *  - It exits rather than continuing if it loses the lease.
 */

const WORKER_VERSION = '1.0.0';

interface Args {
  once: boolean;
  login: boolean;
  forceTakeover: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    once: argv.includes('--once'),
    login: argv.includes('--login'),
    forceTakeover: argv.includes('--force-takeover'),
  };
}

/** Deterministic-ish pacing between actions, drawn from the campaign config. */
function pickDelayMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(1, minSeconds);
  const max = Math.max(min, maxSeconds);
  const span = max - min;
  return Math.round((min + Math.random() * span) * 1000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class Worker {
  private readonly logger: Logger;
  private readonly api: WorkerApiClient;
  private readonly env = workerEnv();

  private workerId: string | null = null;
  private session: BrowserSession | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private stopReason: string | null = null;
  private currentSessionStatus:
    | 'UNKNOWN'
    | 'CONNECTED'
    | 'DISCONNECTED'
    | 'LOGIN_REQUIRED'
    | 'CHALLENGE_DETECTED' = 'UNKNOWN';

  constructor(private readonly args: Args) {
    this.logger = createLogger({ worker: this.env.WORKER_NAME });
    this.api = new WorkerApiClient({
      baseUrl: this.env.WORKER_API_BASE_URL,
      token: this.env.WORKER_API_TOKEN,
      logger: this.logger,
    });
  }

  async run(): Promise<number> {
    this.installSignalHandlers();

    // --- Register and take the exclusive lease ---------------------------
    const registration = await this.api.register({
      name: this.env.WORKER_NAME,
      hostname: hostname(),
      pid: process.pid,
      version: WORKER_VERSION,
      forceTakeover: this.args.forceTakeover,
    });

    if (!registration.ok) {
      this.logger.error(
        'Another worker already holds the exclusive run lease. Refusing to start a second ' +
          'worker, because two workers could send duplicate invitations.',
        {
          holderName: registration.holder.name,
          holderHost: registration.holder.hostname,
          holderPid: registration.holder.pid,
          holderLastHeartbeat: registration.holder.lastHeartbeatAt,
        },
      );
      this.logger.error(
        'If that worker is definitely gone, restart with --force-takeover to claim the lease.',
      );
      return 1;
    }

    this.workerId = registration.workerId;
    this.logger.info('Registered and holding the run lease', {
      workerId: this.workerId,
      tookOverFrom: registration.tookOverFrom,
    });

    this.startHeartbeat();

    try {
      // --- Launch the browser and verify the session --------------------
      await this.heartbeat({ status: 'STARTING', browserStatus: 'LAUNCHING' });

      this.session = await launchPersistentSession({
        profileDir: this.env.BROWSER_PROFILE_DIR,
        headless: this.env.WORKER_HEADLESS,
        navTimeoutMs: this.env.WORKER_NAV_TIMEOUT_MS,
        logger: this.logger,
        mockBaseUrl: this.env.MOCK_LINKEDIN_BASE_URL,
      });

      await this.heartbeat({ browserStatus: 'OPEN' });

      const sessionOk = await this.verifySession();
      if (!sessionOk) return 1;

      // --- Main loop -----------------------------------------------------
      return await this.mainLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Worker failed with an unexpected error', { error: message });
      await this.reportIncident({
        type: 'BROWSER_ERROR',
        severity: 'CRITICAL',
        title: 'Worker crashed',
        description: message,
        blocksWorker: false,
      });
      return 1;
    } finally {
      await this.shutdown(this.stopReason ?? 'Worker exited');
    }
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  /**
   * Confirm the persistent profile is logged in before any outreach.
   *
   * A worker that starts unauthenticated must not claim jobs: every one would
   * burn an attempt and produce a LOGIN_REQUIRED escalation.
   */
  private async verifySession(): Promise<boolean> {
    if (!this.session) return false;

    const feedUrl = this.env.MOCK_LINKEDIN_BASE_URL
      ? `${this.env.MOCK_LINKEDIN_BASE_URL}/feed`
      : LINKEDIN_FEED_URL;

    const result = await detectSessionState(
      this.session.page,
      feedUrl,
      this.env.WORKER_NAV_TIMEOUT_MS,
    );

    this.logger.info('Session check complete', {
      state: result.state,
      matchedBy: result.matchedBy,
    });

    if (result.state === 'AUTHENTICATED') {
      this.currentSessionStatus = 'CONNECTED';
      await this.heartbeat({ status: 'IDLE', sessionStatus: 'CONNECTED' });
      return true;
    }

    // Everything else is a stop condition, reported honestly.
    const screenshot = await captureScreenshot(
      this.session.page,
      this.env.SCREENSHOT_DIR,
      `session-${result.state}`,
      this.logger,
    );

    if (result.state === 'CAPTCHA' || result.state === 'SECURITY_CHALLENGE') {
      this.currentSessionStatus = 'CHALLENGE_DETECTED';
      this.logger.error(
        'LinkedIn is presenting a verification challenge. Stopping. Open the browser profile ' +
          'yourself, complete the challenge, then resolve the incident on the dashboard.',
      );
      await this.reportIncident({
        type: result.state === 'CAPTCHA' ? 'CAPTCHA' : 'SECURITY_CHALLENGE',
        severity: 'CRITICAL',
        title: `${result.state} on session check`,
        description:
          `The worker found a ${result.state} before claiming any work. No outreach was ` +
          'attempted. Complete the challenge by hand, then resolve this incident.',
        blocksWorker: true,
        pageState: result.state,
        pageUrl: result.url,
        screenshotPath: screenshot,
        engageKillSwitch: true,
      });
    } else if (result.state === 'ACCOUNT_RESTRICTED') {
      this.currentSessionStatus = 'CHALLENGE_DETECTED';
      this.logger.error('The LinkedIn account appears restricted. Stopping all automation.');
      await this.reportIncident({
        type: 'ACCOUNT_RESTRICTED',
        severity: 'CRITICAL',
        title: 'Account restricted',
        description:
          'The session check detected an account restriction. All automation is stopped and ' +
          'will not restart until the restriction is resolved and the stop is cleared by hand.',
        blocksWorker: true,
        pageState: result.state,
        pageUrl: result.url,
        screenshotPath: screenshot,
        engageKillSwitch: true,
      });
    } else if (result.state === 'LOGIN_REQUIRED' || result.state === 'UNKNOWN_PAGE') {
      this.currentSessionStatus = 'LOGIN_REQUIRED';
      this.logger.error(
        'The browser profile is not signed in. Run `npm run worker -- --login` and sign in ' +
          'by hand, then start the worker again.',
      );
      await this.reportIncident({
        type: 'LOGIN_REQUIRED',
        severity: 'CRITICAL',
        title: 'Browser session is not signed in',
        description:
          'The persistent browser profile has no signed-in LinkedIn session. Run ' +
          '`npm run worker -- --login`, sign in by hand, then restart the worker.',
        blocksWorker: true,
        pageState: result.state,
        pageUrl: result.url,
        screenshotPath: screenshot,
      });
    } else {
      this.currentSessionStatus = 'DISCONNECTED';
      this.logger.error('Could not reach LinkedIn to verify the session', {
        state: result.state,
      });
      await this.reportIncident({
        type: 'NETWORK_FAILURE',
        severity: 'WARNING',
        title: 'Could not verify the browser session',
        description: `Session check returned ${result.state}: ${result.matchedBy}`,
        blocksWorker: false,
        pageState: result.state,
        pageUrl: result.url,
        screenshotPath: screenshot,
      });
    }

    await this.heartbeat({
      status: 'STOPPED',
      sessionStatus: this.currentSessionStatus,
    });
    this.stopReason = `Session check failed: ${result.state}`;
    return false;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private async mainLoop(): Promise<number> {
    const idleWaitMs = 15_000;

    while (!this.shuttingDown) {
      // --- Gate check before touching any work -------------------------
      const control = await this.safeControl();
      if (!control) {
        await sleep(idleWaitMs);
        continue;
      }

      if (!control.allowed) {
        this.logger.warn('Automation is not permitted right now; holding', {
          reason: control.reason,
          message: control.message,
        });
        await this.heartbeat({ status: 'PAUSED' });

        if (control.killSwitchEngaged || control.reason === 'NOT_LEASE_HOLDER') {
          // These do not resolve on their own. Exit rather than idle forever.
          this.stopReason = control.message;
          this.logger.error('Stopping', { reason: control.reason });
          return control.reason === 'NOT_LEASE_HOLDER' ? 1 : 0;
        }

        if (this.args.once) {
          this.stopReason = control.message;
          return 0;
        }
        await sleep(idleWaitMs);
        continue;
      }

      // --- Claim ---------------------------------------------------------
      const claim = await this.safeClaim();
      if (!claim) {
        await sleep(idleWaitMs);
        continue;
      }

      if (claim.status === 'BLOCKED') {
        this.logger.warn('Claim refused by the safety gate', {
          reason: claim.reason,
          message: claim.message,
        });
        await this.heartbeat({ status: 'PAUSED' });
        if (this.args.once) return 0;
        await sleep(idleWaitMs);
        continue;
      }

      if (claim.status === 'EMPTY') {
        this.logger.info('No eligible work', {
          reason: claim.reason,
          nextEligibleAt: claim.nextEligibleAt,
        });
        await this.heartbeat({ status: 'IDLE', currentJobId: null });
        if (this.args.once) return 0;
        await sleep(idleWaitMs);
        continue;
      }

      // --- Process -------------------------------------------------------
      const stopAfter = await this.processJob(claim.job);

      if (stopAfter) {
        this.stopReason = 'Stopping after a state that requires human review';
        return 0;
      }

      if (this.args.once) return 0;

      // Pace the next action using the campaign's configured spacing.
      const delayMs = pickDelayMs(
        claim.job.campaign.minActionDelaySeconds,
        claim.job.campaign.maxActionDelaySeconds,
      );
      this.logger.info('Waiting before the next action', { seconds: Math.round(delayMs / 1000) });
      await this.heartbeat({ status: 'IDLE', currentJobId: null });
      await sleep(delayMs);
    }

    return 0;
  }

  /**
   * Process one claimed job.
   *
   * Returns true when the worker must stop afterwards (a safety state was
   * detected). While the job runs, the control gate is polled concurrently and
   * the action is aborted if the emergency stop fires.
   */
  private async processJob(job: ClaimedJobPayload): Promise<boolean> {
    const logger = this.logger.child({ jobId: job.jobId, lead: job.lead.fullName });
    const startedAt = Date.now();

    await this.heartbeat({ status: 'RUNNING', currentJobId: job.jobId });

    if (job.action !== 'CONNECT') {
      // Honest refusal rather than a fake success. MESSAGE, FOLLOW and
      // PROFILE_VISIT exist in the enum but are not implemented.
      logger.error('Unsupported action; failing the job rather than pretending to run it', {
        action: job.action,
      });
      await this.api.fail({
        workerId: this.workerId!,
        jobId: job.jobId,
        claimToken: job.claimToken,
        error: `Action ${job.action} is not implemented by this worker. Only CONNECT is supported.`,
        errorClass: 'PERMANENT',
      });
      return false;
    }

    if (!this.session) {
      logger.error('No browser session available');
      return true;
    }

    // The server renders the connection note. If it could not be rendered for
    // this lead, skip without ever loading the profile - a template problem
    // must not cost a profile visit or an activity-budget slot.
    if (job.noteRenderError) {
      logger.warn('Connection note could not be rendered server-side; skipping this lead', {
        reason: job.noteRenderError,
      });
      await this.api.fail({
        workerId: this.workerId!,
        jobId: job.jobId,
        claimToken: job.claimToken,
        error: job.noteRenderError,
        errorClass: 'PERMANENT',
      });
      await this.reportIncident({
        type: 'PROFILE_UNPROCESSABLE',
        severity: 'INFO',
        title: `Skipped ${job.lead.fullName}: connection note could not be rendered`,
        description: job.noteRenderError,
        blocksWorker: false,
        leadId: job.lead.id,
        campaignId: job.campaign.id,
        queueJobId: job.jobId,
      });
      return false;
    }

    const abort = new AbortController();
    const watchdog = this.startControlWatchdog(abort, logger);

    try {
      const outcome = await performConnect({
        page: this.session.page,
        linkedinUrl: job.lead.linkedinUrl,
        logger,
        navTimeoutMs: this.env.WORKER_NAV_TIMEOUT_MS,
        note: job.note,
        signal: abort.signal,
        mockBaseUrl: this.env.MOCK_LINKEDIN_BASE_URL,
      });

      const durationMs = Date.now() - startedAt;

      switch (outcome.kind) {
        case 'SENT': {
          logger.info('Invitation sent and verified', { verifiedBy: outcome.verifiedBy });
          await this.api.complete({
            workerId: this.workerId!,
            jobId: job.jobId,
            claimToken: job.claimToken,
            result: 'SENT',
            durationMs,
            detail: { verifiedBy: outcome.verifiedBy, noteSent: outcome.noteSent },
          });
          return false;
        }

        case 'STATE': {
          logger.info('Terminal state reached, nothing sent', { state: outcome.state });
          await this.api.complete({
            workerId: this.workerId!,
            jobId: job.jobId,
            claimToken: job.claimToken,
            result: outcome.state,
            pageState: outcome.state,
            durationMs,
            detail: { matchedBy: outcome.matchedBy },
          });
          return false;
        }

        case 'UNPROCESSABLE': {
          logger.warn('Profile could not be processed; escalating for review', {
            reason: outcome.reason,
          });
          const screenshot = await captureScreenshot(
            this.session.page,
            this.env.SCREENSHOT_DIR,
            `unprocessable-${job.jobId}`,
            logger,
          );
          await this.api.fail({
            workerId: this.workerId!,
            jobId: job.jobId,
            claimToken: job.claimToken,
            error: outcome.reason,
            errorClass: 'PERMANENT',
            pageState: outcome.state,
            pageUrl: this.session.page.url(),
            screenshotPath: screenshot,
          });
          await this.reportIncident({
            type: 'PROFILE_UNPROCESSABLE',
            severity: 'WARNING',
            title: `Could not process ${job.lead.fullName}`,
            description: outcome.reason,
            // One awkward profile must not halt the whole run.
            blocksWorker: false,
            leadId: job.lead.id,
            campaignId: job.campaign.id,
            queueJobId: job.jobId,
            pageState: outcome.state,
            pageUrl: this.session.page.url(),
            screenshotPath: screenshot,
          });
          return false;
        }

        case 'TECHNICAL_FAILURE': {
          logger.warn('Technical failure; will be retried with backoff', {
            message: outcome.message,
          });
          await this.api.fail({
            workerId: this.workerId!,
            jobId: job.jobId,
            claimToken: job.claimToken,
            error: outcome.message,
            errorClass: 'TECHNICAL',
            pageState: 'NETWORK_ERROR',
            pageUrl: this.session.page.url(),
          });
          return false;
        }

        case 'SAFETY': {
          logger.error(
            'Safety state detected. Stopping the worker. This is not retried and no attempt ' +
              'is made to get past it.',
            { state: outcome.state, matchedBy: outcome.matchedBy },
          );
          const screenshot = await captureScreenshot(
            this.session.page,
            this.env.SCREENSHOT_DIR,
            `safety-${outcome.state}`,
            logger,
          );
          await this.api.fail({
            workerId: this.workerId!,
            jobId: job.jobId,
            claimToken: job.claimToken,
            error: `${outcome.state} detected: ${outcome.matchedBy}`,
            errorClass: 'SAFETY',
            pageState: outcome.state,
            pageUrl: this.session.page.url(),
            screenshotPath: screenshot,
          });
          this.currentSessionStatus =
            outcome.state === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'CHALLENGE_DETECTED';
          await this.heartbeat({ sessionStatus: this.currentSessionStatus });
          return true;
        }
      }
    } catch (error) {
      if (error instanceof AbortError) {
        logger.warn('Job aborted by emergency stop');
        await this.api.fail({
          workerId: this.workerId!,
          jobId: job.jobId,
          claimToken: job.claimToken,
          error: 'Aborted mid-action by the emergency stop.',
          errorClass: 'TECHNICAL',
        });
        this.shuttingDown = true;
        this.stopReason = 'Emergency stop';
        return true;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('Unexpected error while processing the job', { error: message });

      const screenshot = this.session
        ? await captureScreenshot(
            this.session.page,
            this.env.SCREENSHOT_DIR,
            `browser-error-${job.jobId}`,
            logger,
          )
        : null;

      await this.api
        .fail({
          workerId: this.workerId!,
          jobId: job.jobId,
          claimToken: job.claimToken,
          error: message,
          errorClass: 'TECHNICAL',
          screenshotPath: screenshot,
        })
        .catch(() => undefined);

      return false;
    } finally {
      clearInterval(watchdog);
    }
  }

  /**
   * Poll the control gate while a job runs, and abort the in-flight action if
   * the emergency stop fires. Without this, a stop would only take effect at the
   * next claim - potentially minutes later, after another invitation went out.
   */
  private startControlWatchdog(abort: AbortController, logger: Logger): NodeJS.Timeout {
    return setInterval(() => {
      void (async () => {
        if (abort.signal.aborted) return;
        try {
          const control = await this.api.control(this.workerId!);
          if (!control.allowed) {
            logger.warn('Control gate closed mid-job; aborting the current action', {
              reason: control.reason,
            });
            abort.abort();
          }
        } catch {
          // A transient failure to reach the API is not grounds for aborting a
          // job that is already in flight; the next poll will retry.
        }
      })();
    }, this.env.WORKER_CONTROL_POLL_MS);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat({});
    }, this.env.WORKER_HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeat(input: {
    status?: 'STARTING' | 'IDLE' | 'RUNNING' | 'PAUSED' | 'DRAINING' | 'STOPPED' | 'UNHEALTHY';
    browserStatus?: 'CLOSED' | 'LAUNCHING' | 'OPEN' | 'CRASHED';
    sessionStatus?:
      | 'UNKNOWN'
      | 'CONNECTED'
      | 'DISCONNECTED'
      | 'LOGIN_REQUIRED'
      | 'CHALLENGE_DETECTED';
    currentJobId?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    if (!this.workerId) return;
    try {
      const result = await this.api.heartbeat({ workerId: this.workerId, ...input });
      if (result.ok && !result.holdsLease && !this.shuttingDown) {
        this.logger.error(
          'Lost the exclusive run lease - another worker took over. Shutting down to avoid ' +
            'duplicate sends.',
        );
        this.shuttingDown = true;
        this.stopReason = 'Lost the run lease';
      }
    } catch (error) {
      this.logger.warn('Heartbeat failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async safeControl() {
    try {
      return await this.api.control(this.workerId!);
    } catch (error) {
      const retryable = error instanceof WorkerApiError ? error.retryable : true;
      this.logger.warn('Could not read control state', {
        error: error instanceof Error ? error.message : String(error),
        retryable,
      });
      return null;
    }
  }

  private async safeClaim() {
    try {
      return await this.api.claim(this.workerId!);
    } catch (error) {
      this.logger.warn('Claim request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async reportIncident(input: {
    type: string;
    severity: string;
    title: string;
    description: string;
    blocksWorker: boolean;
    campaignId?: string | null;
    leadId?: string | null;
    queueJobId?: string | null;
    pageState?: PageState | null;
    pageUrl?: string | null;
    screenshotPath?: string | null;
    engageKillSwitch?: boolean;
  }): Promise<void> {
    try {
      await this.api.createIncident({ ...input, workerId: this.workerId });
    } catch (error) {
      this.logger.error('Could not record the incident on the dashboard', {
        error: error instanceof Error ? error.message : String(error),
        incidentTitle: input.title,
      });
    }
  }

  private installSignalHandlers(): void {
    const onSignal = (signal: string) => {
      if (this.shuttingDown) return;
      this.logger.info(`Received ${signal}; finishing up and shutting down`);
      this.shuttingDown = true;
      this.stopReason = `Received ${signal}`;
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    if (this.session) {
      await this.session.close();
      this.session = null;
    }

    if (this.workerId) {
      await this.api.tryReportStopped(this.workerId, reason);
    }

    this.logger.info('Worker stopped', { reason });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.login) {
    const env = workerEnv();
    const logger = createLogger({ mode: 'login' });
    const result = await runInteractiveLogin({
      profileDir: env.BROWSER_PROFILE_DIR,
      navTimeoutMs: env.WORKER_NAV_TIMEOUT_MS,
      logger,
    });
    process.exit(result === 'AUTHENTICATED' ? 0 : 1);
  }

  const worker = new Worker(args);
  const code = await worker.run();
  process.exit(code);
}

void main().catch((error) => {
  const logger = createLogger();
  logger.error('Worker exited with a fatal error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
