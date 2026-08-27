import type {
  BrowserStatus,
  ErrorClass,
  PageState,
  SessionStatus,
  WorkerStatus,
} from '@prisma/client';

import type { Logger } from './logger';

/**
 * HTTP client for the worker -> dashboard API.
 *
 * This is the worker's ONLY access path to state. It holds no database
 * credentials, so a compromised worker host cannot read the lead list or
 * rewrite history directly - it can only make the calls this file makes, all of
 * which are validated server-side with Zod.
 */

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  timeoutMs?: number;
}

export class WorkerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'WorkerApiError';
  }

  /** Transport-level and 5xx failures are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface ClaimedJobPayload {
  jobId: string;
  claimToken: string;
  action: 'CONNECT' | 'MESSAGE' | 'FOLLOW' | 'PROFILE_VISIT';
  attempts: number;
  maxAttempts: number;
  claimExpiresAt: string;
  lead: {
    id: string;
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    jobTitle: string | null;
    linkedinUrl: string;
  };
  campaign: {
    id: string;
    name: string;
    minActionDelaySeconds: number;
    maxActionDelaySeconds: number;
  };
  /** Finished connection note, already rendered server-side. */
  note: string | null;
  /**
   * Set when the note could not be rendered for this lead. The worker skips the
   * lead without loading the profile rather than sending an incomplete note.
   */
  noteRenderError: string | null;
}

export type ClaimResponse =
  | { status: 'CLAIMED'; job: ClaimedJobPayload }
  | { status: 'BLOCKED'; reason: string; message: string }
  | { status: 'EMPTY'; reason: string; nextEligibleAt: string | null };

export interface ControlResponse {
  allowed: boolean;
  reason: string;
  message: string;
  controlEpoch: number;
  killSwitchEngaged: boolean;
  blockingIncidentCount: number;
}

export class WorkerApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(
    path: string,
    body: unknown,
    method: 'POST' | 'GET' = 'POST',
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          // The bearer token is the only credential the worker holds, and it is
          // never logged - see logger.scrub.
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 500) };
        }
      }

      if (!response.ok) {
        throw new WorkerApiError(
          `${method} ${path} failed with ${response.status}`,
          response.status,
          parsed,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof WorkerApiError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkerApiError(`${method} ${path} failed: ${message}`, 0, null);
    } finally {
      clearTimeout(timer);
    }
  }

  async register(input: {
    name: string;
    hostname: string;
    pid: number;
    version: string;
    forceTakeover: boolean;
  }): Promise<
    | { ok: true; workerId: string; leaseExpiresAt: string; tookOverFrom: string | null }
    | {
        ok: false;
        reason: 'LEASE_HELD';
        holder: { id: string; name: string; hostname: string; pid: number; lastHeartbeatAt: string };
      }
  > {
    try {
      return await this.request('/api/worker/register', input);
    } catch (error) {
      // A refused lease is a 409 carrying a meaningful body, not a transport
      // failure - unwrap it into the union rather than throwing.
      if (
        error instanceof WorkerApiError &&
        error.status === 409 &&
        typeof error.body === 'object' &&
        error.body !== null &&
        (error.body as { reason?: unknown }).reason === 'LEASE_HELD'
      ) {
        return error.body as {
          ok: false;
          reason: 'LEASE_HELD';
          holder: {
            id: string;
            name: string;
            hostname: string;
            pid: number;
            lastHeartbeatAt: string;
          };
        };
      }
      throw error;
    }
  }

  async heartbeat(input: {
    workerId: string;
    status?: WorkerStatus;
    browserStatus?: BrowserStatus;
    sessionStatus?: SessionStatus;
    currentJobId?: string | null;
    lastError?: string | null;
  }): Promise<
    | { ok: true; leaseExpiresAt: string; holdsLease: boolean; controlEpoch: number }
    | { ok: false; reason: string }
  > {
    return this.request('/api/worker/heartbeat', input);
  }

  async control(workerId: string): Promise<ControlResponse> {
    return this.request('/api/worker/control', { workerId });
  }

  async claim(workerId: string): Promise<ClaimResponse> {
    return this.request('/api/worker/claim', { workerId });
  }

  async complete(input: {
    workerId: string;
    jobId: string;
    claimToken: string;
    result: PageState | 'SENT';
    pageState?: PageState | null;
    screenshotPath?: string | null;
    durationMs?: number | null;
    detail?: Record<string, unknown> | null;
  }): Promise<{ ok: boolean; reason?: string }> {
    return this.request('/api/worker/complete', input);
  }

  async fail(input: {
    workerId: string;
    jobId: string;
    claimToken: string;
    error: string;
    errorClass: ErrorClass;
    pageState?: PageState | null;
    pageUrl?: string | null;
    screenshotPath?: string | null;
  }): Promise<{
    ok: boolean;
    disposition?: string;
    incidentId?: string | null;
    killSwitchEngaged?: boolean;
    reason?: string;
  }> {
    return this.request('/api/worker/fail', input);
  }

  /**
   * Open an incident for a condition that is not tied to a claimed job - a
   * failed session check, a crash, an unreachable browser.
   */
  async createIncident(input: {
    type: string;
    severity: string;
    title: string;
    description: string;
    blocksWorker: boolean;
    campaignId?: string | null;
    leadId?: string | null;
    queueJobId?: string | null;
    workerId?: string | null;
    pageState?: PageState | null;
    pageUrl?: string | null;
    screenshotPath?: string | null;
    engageKillSwitch?: boolean;
  }): Promise<{ ok: boolean; incidentId?: string; killSwitchEngaged?: boolean }> {
    return this.request('/api/worker/incident', input);
  }

  async reportStopped(workerId: string, reason: string): Promise<{ ok: boolean }> {
    return this.request('/api/worker/stopped', { workerId, reason });
  }

  /**
   * Best-effort call used on shutdown paths, where a failure to report must not
   * mask the original reason for stopping.
   */
  async tryReportStopped(workerId: string, reason: string): Promise<void> {
    try {
      await this.reportStopped(workerId, reason);
    } catch (error) {
      this.logger.warn('Could not report worker shutdown to the dashboard', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
