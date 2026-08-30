import { randomBytes } from 'node:crypto';

import {
  Prisma,
  type ErrorClass,
  type LeadStatus,
  type PageState,
  type QueueAction,
} from '@prisma/client';

import { countOutreachActions, logActivity, type DbClient } from './activity';
import { prisma } from './db';
import { serverEnv } from './env';
import { openIncident } from './incidents';
import {
  policyFor,
  SENT_POLICY,
  SENT_RESULT,
  UNPROCESSABLE_POLICY,
} from './page-state-policy';
import { evaluateWorkerGate } from './safety';
import { describeRenderFailure, renderTemplate } from './template';
import {
  backoffDelayMs,
  buildSchedule,
  evaluateEligibility,
  localDayBounds,
  type EligibilityReason,
  type ScheduleConfig,
} from './schedule';

/**
 * The persistent outreach queue.
 *
 * Everything here is durable: jobs live in PostgreSQL, so a restart of the
 * dashboard or the worker loses nothing. A job that was in flight when a
 * process died is recovered by `reapExpiredClaims`, not forgotten.
 *
 * Duplicate protection (requirement 16) is layered, and each layer is
 * independently sufficient to prevent a second invitation:
 *
 *  1. `leads.linkedinUrl` is globally unique - one row per person, ever.
 *  2. Partial unique index on `(lead_id, action) WHERE status IN
 *     ('WAITING','PROCESSING')` - at most one live job per lead per action.
 *  3. Partial unique index on `(lead_id, action) WHERE status = 'COMPLETED'` -
 *     a resolved action can never be recorded twice.
 *  4. `claimNextJob` re-verifies lead state inside the claiming transaction and
 *     takes the row with `FOR UPDATE ... SKIP LOCKED`, so two workers can never
 *     hold the same job.
 *  5. `leads.invitationSentAt` is checked before every claim.
 */

const CLAIM_LEASE_MS = 5 * 60_000;

function newClaimToken(): string {
  return randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------
// Queue generation
// ---------------------------------------------------------------------------

export interface GenerateQueueInput {
  campaignId: string;
  action?: QueueAction;
  /** Cap on jobs created in this pass. */
  limit?: number;
  actorId?: string | null;
  actorName?: string | null;
  /** Deterministic jitter source; tests pass a fixed sequence. */
  jitter?: (index: number) => number;
  now?: Date;
}

export interface GenerateQueueResult {
  created: number;
  skippedAlreadyQueued: number;
  skippedAlreadyResolved: number;
  eligibleLeads: number;
  firstScheduledFor: Date | null;
  lastScheduledFor: Date | null;
}

/**
 * Create WAITING jobs for a campaign's pending leads.
 *
 * Idempotent: running it twice does not double-queue anyone. Leads that already
 * have a live or completed job for the action are skipped in the query, and the
 * partial unique indexes catch anything that slips through a race.
 */
export async function generateQueueForCampaign(
  input: GenerateQueueInput,
): Promise<GenerateQueueResult> {
  const action = input.action ?? 'CONNECT';
  const now = input.now ?? new Date();

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { settings: true },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found`);
  if (!campaign.settings) {
    throw new Error(`Campaign ${input.campaignId} has no settings row - cannot schedule`);
  }

  const config = toScheduleConfig(campaign.settings);

  // Leads that could be queued: pending or previously failed, never contacted,
  // and with no live or resolved job for this action.
  const candidates = await prisma.lead.findMany({
    where: {
      campaignId: campaign.id,
      status: { in: ['PENDING', 'FAILED'] },
      invitationSentAt: null,
      queueJobs: {
        none: {
          action,
          status: { in: ['WAITING', 'PROCESSING', 'COMPLETED', 'REQUIRES_REVIEW'] },
        },
      },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: input.limit ?? 5_000,
  });

  const [skippedAlreadyQueued, skippedAlreadyResolved] = await Promise.all([
    prisma.lead.count({
      where: {
        campaignId: campaign.id,
        queueJobs: { some: { action, status: { in: ['WAITING', 'PROCESSING'] } } },
      },
    }),
    prisma.lead.count({
      where: {
        campaignId: campaign.id,
        queueJobs: { some: { action, status: 'COMPLETED' } },
      },
    }),
  ]);

  if (candidates.length === 0) {
    return {
      created: 0,
      skippedAlreadyQueued,
      skippedAlreadyResolved,
      eligibleLeads: 0,
      firstScheduledFor: null,
      lastScheduledFor: null,
    };
  }

  const schedule = buildSchedule(config, now, candidates.length, input.jitter);
  const plannable = Math.min(schedule.length, candidates.length);

  const data = Array.from({ length: plannable }, (_, i) => ({
    leadId: candidates[i]!.id,
    campaignId: campaign.id,
    action,
    status: 'WAITING' as const,
    scheduledFor: schedule[i]!,
    maxAttempts: campaign.settings!.maxAttemptsPerLead,
  }));

  // `skipDuplicates` emits ON CONFLICT DO NOTHING, which covers the partial
  // unique indexes as well as the declared constraints.
  const result = await prisma.queueJob.createMany({ data, skipDuplicates: true });

  await logActivity({
    action: 'QUEUE_GENERATED',
    result: 'SUCCESS',
    actorType: input.actorId ? 'USER' : 'SYSTEM',
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    campaignId: campaign.id,
    message: `Queued ${result.count} ${action} job(s) for "${campaign.name}".`,
    metadata: {
      action,
      requested: candidates.length,
      created: result.count,
      schedulable: plannable,
    },
  });

  return {
    created: result.count,
    skippedAlreadyQueued,
    skippedAlreadyResolved,
    eligibleLeads: candidates.length,
    firstScheduledFor: data[0]?.scheduledFor ?? null,
    lastScheduledFor: data[data.length - 1]?.scheduledFor ?? null,
  };
}

export function toScheduleConfig(settings: {
  timezone: string;
  windowStartMinute: number;
  windowEndMinute: number;
  operatingDays: number[];
  dailyLimit: number;
  minActionDelaySeconds: number;
  maxActionDelaySeconds: number;
}): ScheduleConfig {
  return {
    timezone: settings.timezone,
    windowStartMinute: settings.windowStartMinute,
    windowEndMinute: settings.windowEndMinute,
    operatingDays: settings.operatingDays,
    dailyLimit: settings.dailyLimit,
    minActionDelaySeconds: settings.minActionDelaySeconds,
    maxActionDelaySeconds: settings.maxActionDelaySeconds,
  };
}

// ---------------------------------------------------------------------------
// Burst scheduling
// ---------------------------------------------------------------------------

export interface ScheduleBurstInput {
  campaignId: string;
  /** How many invitations to send in this burst. */
  count: number;
  /** How long to spread them over, in minutes. */
  minutes: number;
  actorId?: string | null;
  actorName?: string | null;
  now?: Date;
}

export interface ScheduleBurstResult {
  scheduled: number;
  /** Requested minus scheduled, with the reason it was trimmed. */
  trimmedTo: number | null;
  trimReason: 'CAMPAIGN_DAILY_LIMIT' | 'GLOBAL_DAILY_LIMIT' | 'NOT_ENOUGH_LEADS' | null;
  firstAt: Date | null;
  lastAt: Date | null;
  remainingTodayAfter: number;
}

/**
 * Bring `count` waiting jobs forward and spread them across the next `minutes`.
 *
 * This exists so the daily decision - "send thirty over the next half hour" -
 * can be made in the dashboard rather than by editing campaign settings and
 * regenerating a queue. The operating window and the weekday list are about the
 * campaign's *standing* rhythm; a burst is an explicit instruction for right
 * now, and is deliberately allowed to run outside them.
 *
 * What it will not do is exceed a limit. The campaign's daily limit and the
 * global ceiling both still apply, counted against what has actually been sent
 * today, and the request is trimmed rather than refused so the operator gets
 * what is available instead of an error.
 *
 * Spacing is even, with jitter, and never below fifteen seconds - a burst is a
 * scheduling convenience, not a way to fire thirty invitations in a second.
 */
export async function scheduleBurst(input: ScheduleBurstInput): Promise<ScheduleBurstResult> {
  const now = input.now ?? new Date();

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { settings: true },
  });
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found`);
  if (!campaign.settings) throw new Error(`Campaign ${input.campaignId} has no settings row`);

  const env = serverEnv();
  const config = toScheduleConfig(campaign.settings);
  const day = localDayBounds(config.timezone, now);

  const [actionsToday, globalActionsToday] = await Promise.all([
    countOutreachActions({ from: day.start, to: day.end }, { campaignId: campaign.id }),
    countOutreachActions({ from: day.start, to: day.end }, {}),
  ]);

  const campaignRemaining = Math.max(0, campaign.settings.dailyLimit - actionsToday);
  const globalRemaining = Math.max(0, env.GLOBAL_DAILY_ACTION_LIMIT - globalActionsToday);

  let allowed = Math.min(input.count, campaignRemaining, globalRemaining);
  let trimReason: ScheduleBurstResult['trimReason'] = null;
  if (allowed < input.count) {
    trimReason = campaignRemaining <= globalRemaining ? 'CAMPAIGN_DAILY_LIMIT' : 'GLOBAL_DAILY_LIMIT';
  }

  const jobs =
    allowed <= 0
      ? []
      : await prisma.queueJob.findMany({
          where: { campaignId: campaign.id, status: 'WAITING' },
          orderBy: [{ priority: 'asc' }, { scheduledFor: 'asc' }],
          take: allowed,
          select: { id: true },
        });

  if (jobs.length < allowed) {
    allowed = jobs.length;
    if (trimReason === null) trimReason = 'NOT_ENOUGH_LEADS';
  }

  if (allowed === 0) {
    return {
      scheduled: 0,
      trimmedTo: 0,
      trimReason: trimReason ?? 'NOT_ENOUGH_LEADS',
      firstAt: null,
      lastAt: null,
      remainingTodayAfter: Math.min(campaignRemaining, globalRemaining),
    };
  }

  // Even spacing across the window, with the first one a few seconds out so the
  // worker has time to pick it up rather than racing this write.
  const windowMs = Math.max(1, input.minutes) * 60_000;
  const gap = Math.max(15_000, Math.floor(windowMs / allowed));
  const times = jobs.map((_, i) => new Date(now.getTime() + 10_000 + i * gap));

  const burstUntil = new Date(now.getTime() + windowMs + 5 * 60_000);

  await prisma.$transaction([
    ...jobs.map((job, i) =>
      prisma.queueJob.update({
        where: { id: job.id },
        data: { scheduledFor: times[i]!, priority: 0 },
      }),
    ),
    // The override and the reschedule land together: a burst that was allowed
    // to bypass the window must not outlive the jobs it was authorised for.
    prisma.campaignSettings.update({
      where: { campaignId: campaign.id },
      data: { burstUntil },
    }),
  ]);

  await logActivity({
    action: 'QUEUE_GENERATED',
    result: 'SUCCESS',
    actorType: input.actorId ? 'USER' : 'SYSTEM',
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    campaignId: campaign.id,
    message: `Burst: ${allowed} invitation(s) scheduled over the next ${input.minutes} minute(s).`,
    metadata: {
      requested: input.count,
      scheduled: allowed,
      minutes: input.minutes,
      trimReason,
      spacingSeconds: Math.round(gap / 1_000),
    },
  });

  return {
    scheduled: allowed,
    trimmedTo: allowed < input.count ? allowed : null,
    trimReason,
    firstAt: times[0] ?? null,
    lastAt: times[times.length - 1] ?? null,
    remainingTodayAfter: Math.min(campaignRemaining, globalRemaining) - allowed,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface CampaignEligibility {
  campaignId: string;
  campaignName: string;
  eligible: boolean;
  reason: EligibilityReason;
  nextEligibleAt: Date | null;
  remainingToday: number;
  waitingJobs: number;
}

/**
 * Evaluate every activated campaign against its schedule and limits.
 *
 * Read-only. The claim transaction re-checks the daily limit for the campaign it
 * actually picks, so a stale count here can never cause an over-send.
 */
export async function evaluateCampaignEligibility(
  now: Date = new Date(),
  client: DbClient = prisma,
): Promise<CampaignEligibility[]> {
  const env = serverEnv();

  const campaigns = await client.campaign.findMany({
    where: { active: true, status: 'RUNNING' },
    include: { settings: true },
  });

  const results: CampaignEligibility[] = [];

  for (const campaign of campaigns) {
    if (!campaign.settings) {
      results.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        eligible: false,
        reason: 'NO_OPERATING_DAYS',
        nextEligibleAt: null,
        remainingToday: 0,
        waitingJobs: 0,
      });
      continue;
    }

    const config = toScheduleConfig(campaign.settings);
    const day = localDayBounds(config.timezone, now);

    const [actionsToday, globalActionsToday, waitingJobs, nextJob] = await Promise.all([
      countOutreachActions(
        { from: day.start, to: day.end },
        { campaignId: campaign.id },
        client,
      ),
      countOutreachActions({ from: day.start, to: day.end }, {}, client),
      client.queueJob.count({ where: { campaignId: campaign.id, status: 'WAITING' } }),
      client.queueJob.findFirst({
        where: { campaignId: campaign.id, status: 'WAITING' },
        orderBy: [{ priority: 'asc' }, { scheduledFor: 'asc' }],
        select: { scheduledFor: true },
      }),
    ]);

    const evaluation = evaluateEligibility({
      config,
      now,
      actionsToday,
      globalActionsToday,
      globalDailyLimit: env.GLOBAL_DAILY_ACTION_LIMIT,
      earliestScheduledFor: nextJob?.scheduledFor ?? null,
      burstUntil: campaign.settings.burstUntil,
    });

    results.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      eligible: evaluation.eligible && waitingJobs > 0,
      reason: waitingJobs === 0 && evaluation.eligible ? 'NOT_YET_SCHEDULED' : evaluation.reason,
      nextEligibleAt: evaluation.nextEligibleAt,
      remainingToday: evaluation.remainingToday,
      waitingJobs,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimedJob {
  jobId: string;
  claimToken: string;
  action: QueueAction;
  attempts: number;
  maxAttempts: number;
  claimExpiresAt: Date;
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
  /** Rendered connection note, or null when the campaign sends no note. */
  note: string | null;
  /**
   * Set when the campaign has a template but it could not be rendered for this
   * lead. The worker skips the lead without loading the profile.
   */
  noteRenderError: string | null;
}

export type ClaimOutcome =
  | { status: 'CLAIMED'; job: ClaimedJob }
  | { status: 'BLOCKED'; reason: string; message: string }
  | { status: 'EMPTY'; reason: EligibilityReason | 'NO_ACTIVE_CAMPAIGNS'; nextEligibleAt: Date | null };

interface ClaimRow {
  id: string;
  leadId: string;
  campaignId: string;
  action: QueueAction;
  attempts: number;
  maxAttempts: number;
}

/** Thrown to roll the claim transaction back when a post-claim re-check fails. */
class ClaimRollback extends Error {
  constructor(readonly detail: { reason: EligibilityReason }) {
    super(`claim rolled back: ${detail.reason}`);
  }
}

/**
 * Atomically claim the next eligible job.
 *
 * Order of operations matters:
 *  1. Check the global safety gate. A latched kill switch or an unresolved
 *     blocking incident stops everything before any row is touched.
 *  2. Compute campaign eligibility (operating hours, daily limits) in the
 *     campaign's own timezone.
 *  3. Take one WAITING row with `FOR UPDATE ... SKIP LOCKED`, re-verifying lead
 *     state and the absence of a resolved job for the same lead and action
 *     *inside* the same transaction.
 *  4. Re-count the campaign's actions for its local day and roll back if the
 *     limit was reached in the meantime.
 */
export async function claimNextJob(params: {
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<ClaimOutcome> {
  const now = params.now ?? new Date();
  const env = serverEnv();

  const gate = await evaluateWorkerGate(params.workerId);
  if (!gate.allowed) {
    return { status: 'BLOCKED', reason: gate.reason, message: gate.message };
  }

  const eligibility = await evaluateCampaignEligibility(now);
  if (eligibility.length === 0) {
    return { status: 'EMPTY', reason: 'NO_ACTIVE_CAMPAIGNS', nextEligibleAt: null };
  }

  const eligible = eligibility.filter((e) => e.eligible);
  if (eligible.length === 0) {
    const soonest = eligibility
      .map((e) => e.nextEligibleAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      status: 'EMPTY',
      reason: eligibility[0]!.reason,
      nextEligibleAt: soonest ?? null,
    };
  }

  const eligibleIds = eligible.map((e) => e.campaignId);
  const claimToken = newClaimToken();
  const claimExpiresAt = new Date(now.getTime() + (params.leaseMs ?? CLAIM_LEASE_MS));

  try {
    const claimed = await prisma.$transaction(async (tx) => {
      // Column identifiers are Prisma defaults (camelCase) and therefore
      // case-sensitive in PostgreSQL - they must stay double-quoted.
      const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
        WITH candidate AS (
          SELECT j."id"
          FROM "queue_jobs" j
          JOIN "campaigns" c ON c."id" = j."campaignId"
          JOIN "leads" l ON l."id" = j."leadId"
          WHERE j."status" = 'WAITING'
            AND j."scheduledFor" <= ${now}
            AND j."campaignId" IN (${Prisma.join(eligibleIds)})
            AND c."active" = TRUE
            AND c."status" = 'RUNNING'
            -- Duplicate guards, re-verified under the row lock.
            AND l."invitationSentAt" IS NULL
            AND l."status" IN ('PENDING', 'FAILED')
            AND NOT EXISTS (
              SELECT 1 FROM "queue_jobs" q2
              WHERE q2."leadId" = j."leadId"
                AND q2."action" = j."action"
                AND q2."id" <> j."id"
                AND q2."status" IN ('COMPLETED', 'PROCESSING')
            )
          ORDER BY j."priority" ASC, j."scheduledFor" ASC, j."createdAt" ASC
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1
        )
        UPDATE "queue_jobs" AS t
        SET "status" = 'PROCESSING',
            "startedAt" = ${now},
            "attempts" = t."attempts" + 1,
            "claimedByWorkerId" = ${params.workerId},
            "claimToken" = ${claimToken},
            "claimedAt" = ${now},
            "claimExpiresAt" = ${claimExpiresAt},
            "error" = NULL,
            "updatedAt" = ${now}
        FROM candidate
        WHERE t."id" = candidate."id"
        RETURNING t."id", t."leadId", t."campaignId", t."action", t."attempts", t."maxAttempts"
      `);

      const row = rows[0];
      if (!row) return null;

      const [lead, campaign] = await Promise.all([
        tx.lead.update({
          where: { id: row.leadId },
          data: { status: 'PROCESSING', lastAttemptAt: now, attempts: { increment: 1 } },
          select: {
            id: true,
            fullName: true,
            firstName: true,
            lastName: true,
            company: true,
            jobTitle: true,
            linkedinUrl: true,
          },
        }),
        tx.campaign.findUniqueOrThrow({
          where: { id: row.campaignId },
          include: { settings: true, messageTemplate: true },
        }),
      ]);

      if (!campaign.settings) throw new Error('campaign settings disappeared mid-claim');

      // Re-check the daily limit under the transaction. Between the read-only
      // eligibility pass and here, another action may have consumed the budget.
      const day = localDayBounds(campaign.settings.timezone, now);
      const [actionsToday, globalToday] = await Promise.all([
        countOutreachActions({ from: day.start, to: day.end }, { campaignId: campaign.id }, tx),
        countOutreachActions({ from: day.start, to: day.end }, {}, tx),
      ]);

      if (actionsToday >= campaign.settings.dailyLimit) {
        throw new ClaimRollback({ reason: 'DAILY_LIMIT_REACHED' });
      }
      if (globalToday >= env.GLOBAL_DAILY_ACTION_LIMIT) {
        throw new ClaimRollback({ reason: 'GLOBAL_DAILY_LIMIT_REACHED' });
      }

      await logActivity(
        {
          action: 'JOB_CLAIMED',
          result: 'INFO',
          actorType: 'WORKER',
          actorId: params.workerId,
          workerId: params.workerId,
          campaignId: campaign.id,
          leadId: lead.id,
          queueJobId: row.id,
          message: `Claimed ${row.action} for ${lead.fullName} (attempt ${row.attempts}/${row.maxAttempts}).`,
        },
        tx,
      );

      const job: ClaimedJob = {
        jobId: row.id,
        claimToken,
        action: row.action,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        claimExpiresAt,
        lead,
        campaign: {
          id: campaign.id,
          name: campaign.name,
          minActionDelaySeconds: campaign.settings.minActionDelaySeconds,
          maxActionDelaySeconds: campaign.settings.maxActionDelaySeconds,
        },
        note: null,
        noteRenderError: null,
      };

      // Render the connection note here, where the template, the lead data and
      // the configured length ceiling all live. The worker receives finished
      // text and has no template logic of its own.
      if (campaign.messageTemplate) {
        const rendered = renderTemplate(
          campaign.messageTemplate.body,
          {
            firstName: lead.firstName,
            lastName: lead.lastName,
            company: lead.company,
            jobTitle: lead.jobTitle,
          },
          { maxLength: env.MAX_CONNECTION_NOTE_CHARS },
        );

        if (rendered.ok) {
          job.note = rendered.text;
        } else if (campaign.settings.skipLeadsMissingTemplateVars) {
          job.noteRenderError = describeRenderFailure(rendered);
        } else {
          // Configured to proceed anyway: send a bare invitation rather than a
          // half-substituted note.
          job.note = null;
        }
      }

      return { job, template: campaign.messageTemplate, settings: campaign.settings };
    });

    if (!claimed) {
      const soonest = eligible
        .map((e) => e.nextEligibleAt)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return { status: 'EMPTY', reason: 'NOT_YET_SCHEDULED', nextEligibleAt: soonest ?? null };
    }

    return { status: 'CLAIMED', job: claimed.job };
  } catch (error) {
    if (error instanceof ClaimRollback) {
      return { status: 'EMPTY', reason: error.detail.reason, nextEligibleAt: null };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompleteJobInput {
  jobId: string;
  claimToken: string;
  workerId: string;
  /** Verified outcome: either a detected page state, or SENT after verification. */
  result: PageState | typeof SENT_RESULT;
  pageState?: PageState | null;
  screenshotPath?: string | null;
  durationMs?: number | null;
  detail?: Prisma.InputJsonValue | null;
  now?: Date;
}

export type CompleteJobResult =
  | { ok: true; leadStatus: LeadStatus | null; campaignCompleted: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'CLAIM_MISMATCH' | 'NOT_PROCESSING' };

/**
 * Record a verified outcome for a claimed job.
 *
 * The `claimToken` must match. A worker whose lease expired and whose job was
 * reclaimed cannot overwrite the new holder's result - it is told
 * `CLAIM_MISMATCH` and drops the outcome.
 */
export async function completeJob(input: CompleteJobInput): Promise<CompleteJobResult> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const job = await tx.queueJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true,
        status: true,
        claimToken: true,
        leadId: true,
        campaignId: true,
        action: true,
        startedAt: true,
      },
    });

    if (!job) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (job.claimToken !== input.claimToken) {
      return { ok: false, reason: 'CLAIM_MISMATCH' } as const;
    }
    if (job.status !== 'PROCESSING') return { ok: false, reason: 'NOT_PROCESSING' } as const;

    const policy = input.result === SENT_RESULT ? SENT_POLICY : policyFor(input.result);
    const pageState = input.pageState ?? (input.result === SENT_RESULT ? null : input.result);

    await tx.queueJob.update({
      where: { id: job.id },
      data: {
        status: policy.queueStatus,
        completedAt: now,
        result: policy.result,
        resultPageState: pageState,
        resultDetail: input.detail ?? undefined,
        errorClass: policy.errorClass,
        error: policy.errorClass === 'NONE' ? null : policy.description,
        claimToken: null,
        claimExpiresAt: null,
      },
    });

    if (policy.leadStatus) {
      await tx.lead.update({
        where: { id: job.leadId },
        data: {
          status: policy.leadStatus,
          lastResult: policy.result,
          lastAttemptAt: now,
          // The authoritative duplicate guard: set once, and every later claim
          // for this lead is filtered out by it.
          ...(policy.result === SENT_RESULT ? { invitationSentAt: now } : {}),
        },
      });
    } else {
      await tx.lead.update({
        where: { id: job.leadId },
        data: { status: 'PENDING', lastResult: policy.result, lastAttemptAt: now },
      });
    }

    await tx.worker.update({
      where: { id: input.workerId },
      data: { jobsProcessed: { increment: 1 }, currentJobId: null },
    });

    await logActivity(
      {
        action: job.action,
        result: resultToActivityResult(policy.result),
        actorType: 'WORKER',
        actorId: input.workerId,
        workerId: input.workerId,
        campaignId: job.campaignId,
        leadId: job.leadId,
        queueJobId: job.id,
        message: policy.description,
        pageState,
        screenshotPath: input.screenshotPath ?? null,
        durationMs:
          input.durationMs ??
          (job.startedAt ? now.getTime() - job.startedAt.getTime() : null),
        metadata: { result: policy.result },
      },
      tx,
    );

    const campaignCompleted = await maybeCompleteCampaign(tx, job.campaignId, now);

    return { ok: true, leadStatus: policy.leadStatus, campaignCompleted } as const;
  });
}

function resultToActivityResult(result: string) {
  switch (result) {
    case 'SENT':
      return 'SUCCESS' as const;
    case 'ALREADY_CONNECTED':
      return 'ALREADY_CONNECTED' as const;
    case 'ALREADY_PENDING':
      return 'ALREADY_PENDING' as const;
    case 'PROFILE_NOT_FOUND':
      return 'SKIPPED' as const;
    case 'CAPTCHA':
    case 'SECURITY_CHALLENGE':
    case 'ACCOUNT_RESTRICTED':
    case 'UNKNOWN_PAGE':
    case 'LOGIN_REQUIRED':
      return 'REQUIRES_REVIEW' as const;
    default:
      return 'INFO' as const;
  }
}

/** Mark a campaign COMPLETED once it has no unfinished work left. */
async function maybeCompleteCampaign(
  tx: Prisma.TransactionClient,
  campaignId: string,
  now: Date,
): Promise<boolean> {
  const outstanding = await tx.queueJob.count({
    where: { campaignId, status: { in: ['WAITING', 'PROCESSING'] } },
  });
  if (outstanding > 0) return false;

  const remainingLeads = await tx.lead.count({
    where: { campaignId, status: { in: ['PENDING', 'PROCESSING'] } },
  });
  if (remainingLeads > 0) return false;

  const updated = await tx.campaign.updateMany({
    where: { id: campaignId, status: 'RUNNING' },
    data: { status: 'COMPLETED', active: false, completedAt: now },
  });

  if (updated.count > 0) {
    await logActivity(
      {
        action: 'CAMPAIGN_COMPLETED',
        result: 'SUCCESS',
        campaignId,
        message: 'All queued work finished; campaign marked COMPLETED.',
      },
      tx,
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

export interface FailJobInput {
  jobId: string;
  claimToken: string;
  workerId: string;
  error: string;
  errorClass: ErrorClass;
  pageState?: PageState | null;
  screenshotPath?: string | null;
  pageUrl?: string | null;
  now?: Date;
}

export type FailJobResult =
  | {
      ok: true;
      disposition: 'RETRY_SCHEDULED' | 'EXHAUSTED' | 'ESCALATED';
      nextAttemptAt: Date | null;
      incidentId: string | null;
      killSwitchEngaged: boolean;
    }
  | { ok: false; reason: 'NOT_FOUND' | 'CLAIM_MISMATCH' | 'NOT_PROCESSING' };

/**
 * Record a failure and decide what happens next.
 *
 *  - TECHNICAL  -> retried with exponential backoff until `maxAttempts`.
 *  - PERMANENT  -> failed immediately, no retry, no incident.
 *  - SAFETY     -> never retried. Job goes to REQUIRES_REVIEW, an incident is
 *                  opened, and (for evidence of a LinkedIn security control)
 *                  the kill switch latches.
 */
export async function failJob(input: FailJobInput): Promise<FailJobResult> {
  const now = input.now ?? new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    const job = await tx.queueJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true,
        status: true,
        claimToken: true,
        leadId: true,
        campaignId: true,
        action: true,
        attempts: true,
        maxAttempts: true,
        startedAt: true,
      },
    });

    if (!job) return { ok: false as const, reason: 'NOT_FOUND' as const };
    if (job.claimToken !== input.claimToken) {
      return { ok: false as const, reason: 'CLAIM_MISMATCH' as const };
    }
    if (job.status !== 'PROCESSING') {
      return { ok: false as const, reason: 'NOT_PROCESSING' as const };
    }

    const isSafety = input.errorClass === 'SAFETY';
    const canRetry = input.errorClass === 'TECHNICAL' && job.attempts < job.maxAttempts;

    // A profile that loaded but offered no usable action is "unprocessable", not
    // a plain failure: requirement 8 step 10 says mark it REQUIRES_REVIEW so a
    // person looks at it. PROFILE_FOUND only ever reaches the failure path in
    // that situation.
    const unprocessable = input.errorClass === 'PERMANENT' && input.pageState === 'PROFILE_FOUND';

    const policy = unprocessable
      ? UNPROCESSABLE_POLICY
      : input.pageState
        ? policyFor(input.pageState)
        : null;

    let disposition: 'RETRY_SCHEDULED' | 'EXHAUSTED' | 'ESCALATED';
    let nextAttemptAt: Date | null = null;

    if (isSafety) {
      disposition = 'ESCALATED';
      await tx.queueJob.update({
        where: { id: job.id },
        data: {
          status: 'REQUIRES_REVIEW',
          error: input.error.slice(0, 4_000),
          errorClass: 'SAFETY',
          resultPageState: input.pageState ?? null,
          result: policy?.result ?? 'SAFETY_STOP',
          completedAt: now,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      await tx.lead.update({
        where: { id: job.leadId },
        data: {
          status: policy?.leadStatus ?? 'REQUIRES_REVIEW',
          lastResult: policy?.result ?? 'SAFETY_STOP',
          lastAttemptAt: now,
        },
      });
    } else if (canRetry) {
      disposition = 'RETRY_SCHEDULED';
      nextAttemptAt = new Date(now.getTime() + backoffDelayMs(job.attempts));
      await tx.queueJob.update({
        where: { id: job.id },
        data: {
          status: 'WAITING',
          error: input.error.slice(0, 4_000),
          errorClass: input.errorClass,
          scheduledFor: nextAttemptAt,
          nextAttemptAt,
          startedAt: null,
          claimedByWorkerId: null,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      // Back to PENDING so the lead is claimable again on the retry.
      await tx.lead.update({
        where: { id: job.leadId },
        data: { status: 'PENDING', lastResult: 'RETRY_PENDING', lastAttemptAt: now },
      });
    } else {
      disposition = 'EXHAUSTED';

      // An unprocessable profile goes to REQUIRES_REVIEW so it surfaces in the
      // review queue; everything else here is a plain FAILED. Restricted to
      // those two so an unexpected policy cannot mark a failed job COMPLETED.
      const terminalStatus =
        policy?.queueStatus === 'REQUIRES_REVIEW' ? 'REQUIRES_REVIEW' : 'FAILED';

      await tx.queueJob.update({
        where: { id: job.id },
        data: {
          status: terminalStatus,
          error: input.error.slice(0, 4_000),
          errorClass: input.errorClass,
          resultPageState: input.pageState ?? null,
          result: policy?.result ?? 'FAILED',
          completedAt: now,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      await tx.lead.update({
        where: { id: job.leadId },
        data: {
          status: policy?.leadStatus ?? 'FAILED',
          lastResult: policy?.result ?? 'FAILED',
          lastAttemptAt: now,
        },
      });
    }

    await tx.worker.update({
      where: { id: input.workerId },
      data: { jobsFailed: { increment: 1 }, currentJobId: null, lastError: input.error.slice(0, 1_000) },
    });

    await logActivity(
      {
        action: job.action,
        result: isSafety ? 'REQUIRES_REVIEW' : 'FAILED',
        actorType: 'WORKER',
        actorId: input.workerId,
        workerId: input.workerId,
        campaignId: job.campaignId,
        leadId: job.leadId,
        queueJobId: job.id,
        message:
          disposition === 'RETRY_SCHEDULED'
            ? `Technical failure on attempt ${job.attempts}/${job.maxAttempts}; retrying later.`
            : disposition === 'ESCALATED'
              ? 'Safety state detected; escalated for human review and not retried.'
              : `Failed permanently after ${job.attempts} attempt(s).`,
        error: input.error,
        pageState: input.pageState ?? null,
        screenshotPath: input.screenshotPath ?? null,
        durationMs: job.startedAt ? now.getTime() - job.startedAt.getTime() : null,
        metadata: { errorClass: input.errorClass, disposition, attempts: job.attempts },
      },
      tx,
    );

    if (disposition === 'RETRY_SCHEDULED') {
      await logActivity(
        {
          action: 'JOB_RETRY_SCHEDULED',
          result: 'INFO',
          actorType: 'WORKER',
          actorId: input.workerId,
          queueJobId: job.id,
          campaignId: job.campaignId,
          leadId: job.leadId,
          message: `Retry scheduled for ${nextAttemptAt?.toISOString()}.`,
        },
        tx,
      );
    }

    return {
      ok: true as const,
      disposition,
      nextAttemptAt,
      job,
      policy,
      isSafety,
    };
  });

  if (!outcome.ok) return outcome;

  // Incidents are opened outside the failure transaction: `openIncident` runs
  // its own transaction (it may also latch the kill switch and pause
  // campaigns), and the failure must be durable even if escalation then fails.
  let incidentId: string | null = null;
  let killSwitchEngaged = false;

  const needsIncident =
    outcome.isSafety ||
    (outcome.disposition === 'EXHAUSTED' && input.errorClass === 'TECHNICAL');

  if (needsIncident) {
    const policy = outcome.policy;
    const opened = await openIncident({
      type: policy?.incidentType ?? (outcome.isSafety ? 'UNEXPECTED_PAGE' : 'BROWSER_ERROR'),
      severity: policy?.incidentSeverity ?? (outcome.isSafety ? 'CRITICAL' : 'WARNING'),
      title: outcome.isSafety
        ? (policy?.description ?? 'Safety state detected - automation stopped')
        : `Job failed after ${outcome.job.attempts} attempts`,
      description: input.error.slice(0, 4_000),
      blocksWorker: outcome.isSafety,
      campaignId: outcome.job.campaignId,
      leadId: outcome.job.leadId,
      queueJobId: outcome.job.id,
      workerId: input.workerId,
      pageState: input.pageState ?? null,
      pageUrl: input.pageUrl ?? null,
      screenshotPath: input.screenshotPath ?? null,
      engageKillSwitch: policy?.engageKillSwitch ?? false,
    });
    incidentId = opened.incidentId;
    killSwitchEngaged = opened.killSwitchEngaged;
  }

  return {
    ok: true,
    disposition: outcome.disposition,
    nextAttemptAt: outcome.nextAttemptAt,
    incidentId,
    killSwitchEngaged,
  };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface ReapResult {
  requeued: number;
  jobIds: string[];
}

/**
 * Recover jobs whose claim lease expired - the worker crashed, was killed, or
 * lost its network. This is what makes "never lose a job to a restart" true.
 *
 * The job goes back to WAITING with its attempt count intact, so a job that
 * repeatedly kills its worker still exhausts `maxAttempts` rather than looping
 * forever.
 */
export async function reapExpiredClaims(now: Date = new Date()): Promise<ReapResult> {
  const expired = await prisma.queueJob.findMany({
    where: { status: 'PROCESSING', claimExpiresAt: { lt: now } },
    select: { id: true, leadId: true, campaignId: true, attempts: true, maxAttempts: true },
    take: 200,
  });

  if (expired.length === 0) return { requeued: 0, jobIds: [] };

  const jobIds: string[] = [];

  for (const job of expired) {
    const exhausted = job.attempts >= job.maxAttempts;

    await prisma.$transaction(async (tx) => {
      const updated = await tx.queueJob.updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: exhausted
          ? {
              status: 'FAILED',
              error: 'Claim lease expired and attempt budget exhausted (worker died mid-job).',
              errorClass: 'TECHNICAL',
              completedAt: now,
              claimToken: null,
              claimExpiresAt: null,
            }
          : {
              status: 'WAITING',
              error: 'Claim lease expired; requeued for another attempt.',
              errorClass: 'TECHNICAL',
              scheduledFor: now,
              startedAt: null,
              claimedByWorkerId: null,
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
            },
      });

      if (updated.count === 0) return;

      await tx.lead.updateMany({
        where: { id: job.leadId, status: 'PROCESSING' },
        data: { status: exhausted ? 'FAILED' : 'PENDING' },
      });

      await logActivity(
        {
          action: exhausted ? 'JOB_FAILED' : 'JOB_RETRY_SCHEDULED',
          result: exhausted ? 'FAILED' : 'INFO',
          campaignId: job.campaignId,
          leadId: job.leadId,
          queueJobId: job.id,
          message: exhausted
            ? 'Abandoned: claim lease expired with no attempts left.'
            : 'Requeued after a stale claim (worker did not report back).',
          error: 'Claim lease expired',
        },
        tx,
      );

      jobIds.push(job.id);
    });
  }

  return { requeued: jobIds.length, jobIds };
}

// ---------------------------------------------------------------------------
// Queue queries
// ---------------------------------------------------------------------------

export interface QueueCounts {
  waiting: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  requiresReview: number;
}

export async function getQueueCounts(
  filter: { campaignId?: string } = {},
  client: DbClient = prisma,
): Promise<QueueCounts> {
  const where = filter.campaignId ? { campaignId: filter.campaignId } : {};
  const grouped = await client.queueJob.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  const counts: QueueCounts = {
    waiting: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    requiresReview: 0,
  };

  for (const row of grouped) {
    const n = row._count._all;
    switch (row.status) {
      case 'WAITING':
        counts.waiting = n;
        break;
      case 'PROCESSING':
        counts.processing = n;
        break;
      case 'COMPLETED':
        counts.completed = n;
        break;
      case 'FAILED':
        counts.failed = n;
        break;
      case 'CANCELLED':
        counts.cancelled = n;
        break;
      case 'REQUIRES_REVIEW':
        counts.requiresReview = n;
        break;
    }
  }

  return counts;
}

/** Next job that will actually run, for the dashboard "Next scheduled task" tile. */
export async function getNextScheduledJob(client: DbClient = prisma) {
  return client.queueJob.findFirst({
    where: { status: 'WAITING', campaign: { active: true, status: 'RUNNING' } },
    orderBy: [{ priority: 'asc' }, { scheduledFor: 'asc' }],
    include: {
      lead: { select: { fullName: true, linkedinUrl: true } },
      campaign: { select: { id: true, name: true } },
    },
  });
}

export async function cancelCampaignQueue(
  campaignId: string,
  reason: string,
  client: DbClient = prisma,
): Promise<number> {
  const result = await client.queueJob.updateMany({
    where: { campaignId, status: 'WAITING' },
    data: { status: 'CANCELLED', completedAt: new Date(), error: reason.slice(0, 1_000) },
  });
  return result.count;
}
