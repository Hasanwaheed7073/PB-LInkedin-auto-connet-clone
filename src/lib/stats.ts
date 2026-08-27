import type { LeadStatus } from '@prisma/client';

import { countOutreachActions, type DbClient } from './activity';
import { prisma } from './db';
import { serverEnv } from './env';
import { countIncidents } from './incidents';
import { evaluateCampaignEligibility, getNextScheduledJob, getQueueCounts } from './queue';
import { getSystemState } from './safety';
import { localDayBounds, localDayKey } from './schedule';
import { summarizeWorkers } from './workers';

/**
 * Dashboard statistics.
 *
 * Every number here is read from the database. There is no mock data and no
 * placeholder path: if a figure cannot be computed it is reported as such rather
 * than filled in with a plausible-looking value.
 */

export type LeadStatusCounts = Record<LeadStatus, number>;

const EMPTY_LEAD_COUNTS: LeadStatusCounts = {
  PENDING: 0,
  PROCESSING: 0,
  SENT: 0,
  ALREADY_CONNECTED: 0,
  ALREADY_PENDING: 0,
  SKIPPED: 0,
  FAILED: 0,
  REQUIRES_REVIEW: 0,
  BLOCKED: 0,
};

export async function getLeadStatusCounts(
  filter: { campaignId?: string } = {},
  client: DbClient = prisma,
): Promise<{ counts: LeadStatusCounts; total: number }> {
  const grouped = await client.lead.groupBy({
    by: ['status'],
    where: filter.campaignId ? { campaignId: filter.campaignId } : {},
    _count: { _all: true },
  });

  const counts = { ...EMPTY_LEAD_COUNTS };
  let total = 0;
  for (const row of grouped) {
    counts[row.status] = row._count._all;
    total += row._count._all;
  }
  return { counts, total };
}

export interface TodayActivity {
  /** Local-day window used for the figures, in the reference timezone. */
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  actionsToday: number;
  invitationsSentToday: number;
  alreadyConnectedToday: number;
  alreadyPendingToday: number;
  failedToday: number;
  requiresReviewToday: number;
  globalDailyLimit: number;
  globalRemaining: number;
}

/**
 * Today's activity, counted in `timezone`.
 *
 * Uses the append-only activity log rather than mutable job rows, so retries are
 * counted once each and nothing can be reset to buy more daily budget.
 */
export async function getTodayActivity(
  timezone: string,
  now: Date = new Date(),
  client: DbClient = prisma,
): Promise<TodayActivity> {
  const env = serverEnv();
  const { start, end } = localDayBounds(timezone, now);

  const [actionsToday, grouped] = await Promise.all([
    countOutreachActions({ from: start, to: end }, {}, client),
    client.activityLog.groupBy({
      by: ['result'],
      where: {
        action: { in: ['CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT'] },
        createdAt: { gte: start, lt: end },
      },
      _count: { _all: true },
    }),
  ]);

  const byResult = new Map(grouped.map((g) => [g.result, g._count._all]));

  return {
    timezone,
    windowStart: start,
    windowEnd: end,
    actionsToday,
    invitationsSentToday: byResult.get('SUCCESS') ?? 0,
    alreadyConnectedToday: byResult.get('ALREADY_CONNECTED') ?? 0,
    alreadyPendingToday: byResult.get('ALREADY_PENDING') ?? 0,
    failedToday: byResult.get('FAILED') ?? 0,
    requiresReviewToday: byResult.get('REQUIRES_REVIEW') ?? 0,
    globalDailyLimit: env.GLOBAL_DAILY_ACTION_LIMIT,
    globalRemaining: Math.max(0, env.GLOBAL_DAILY_ACTION_LIMIT - actionsToday),
  };
}

/**
 * Reference timezone for "today" on the dashboard: the timezone of the
 * campaign that is actually running, falling back to any configured campaign,
 * then UTC. Avoids showing UTC-day counts to an operator working in CET.
 */
export async function resolveDashboardTimezone(client: DbClient = prisma): Promise<string> {
  const running = await client.campaignSettings.findFirst({
    where: { campaign: { active: true, status: 'RUNNING' } },
    select: { timezone: true },
  });
  if (running?.timezone) return running.timezone;

  const any = await client.campaignSettings.findFirst({ select: { timezone: true } });
  return any?.timezone ?? 'UTC';
}

export interface DashboardSnapshot {
  leads: { counts: LeadStatusCounts; total: number };
  queue: Awaited<ReturnType<typeof getQueueCounts>>;
  today: TodayActivity;
  incidents: Awaited<ReturnType<typeof countIncidents>>;
  workers: Awaited<ReturnType<typeof summarizeWorkers>>;
  system: Awaited<ReturnType<typeof getSystemState>>;
  campaigns: {
    total: number;
    draft: number;
    ready: number;
    running: number;
    paused: number;
    completed: number;
    error: number;
  };
  eligibility: Awaited<ReturnType<typeof evaluateCampaignEligibility>>;
  nextScheduled: Awaited<ReturnType<typeof getNextScheduledJob>>;
  generatedAt: Date;
}

/** One round trip for the whole dashboard. */
export async function getDashboardSnapshot(now: Date = new Date()): Promise<DashboardSnapshot> {
  const timezone = await resolveDashboardTimezone();

  const [leads, queue, today, incidents, workers, system, campaignGroups, eligibility, nextScheduled] =
    await Promise.all([
      getLeadStatusCounts(),
      getQueueCounts(),
      getTodayActivity(timezone, now),
      countIncidents(),
      summarizeWorkers(now),
      getSystemState(),
      prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      evaluateCampaignEligibility(now),
      getNextScheduledJob(),
    ]);

  const campaigns = {
    total: 0,
    draft: 0,
    ready: 0,
    running: 0,
    paused: 0,
    completed: 0,
    error: 0,
  };
  for (const row of campaignGroups) {
    const n = row._count._all;
    campaigns.total += n;
    switch (row.status) {
      case 'DRAFT':
        campaigns.draft = n;
        break;
      case 'READY':
        campaigns.ready = n;
        break;
      case 'RUNNING':
        campaigns.running = n;
        break;
      case 'PAUSED':
        campaigns.paused = n;
        break;
      case 'COMPLETED':
        campaigns.completed = n;
        break;
      case 'ERROR':
        campaigns.error = n;
        break;
    }
  }

  return {
    leads,
    queue,
    today,
    incidents,
    workers,
    system,
    campaigns,
    eligibility,
    nextScheduled,
    generatedAt: now,
  };
}

/** Recent activity for the dashboard timeline. */
export async function getRecentActivity(limit = 15, client: DbClient = prisma) {
  return client.activityLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
    include: {
      lead: { select: { id: true, fullName: true, linkedinUrl: true } },
      campaign: { select: { id: true, name: true } },
    },
  });
}

/** Recent failures and escalations, for the dashboard "Recent errors" panel. */
export async function getRecentErrors(limit = 10, client: DbClient = prisma) {
  return client.activityLog.findMany({
    where: { result: { in: ['FAILED', 'REQUIRES_REVIEW'] } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
    include: {
      lead: { select: { id: true, fullName: true } },
      campaign: { select: { id: true, name: true } },
    },
  });
}

export interface DailyActionPoint {
  day: string;
  sent: number;
  alreadyConnected: number;
  alreadyPending: number;
  failed: number;
  requiresReview: number;
}

/**
 * Per-day outreach outcomes over the trailing `days` days, for the activity
 * chart. Grouped in `timezone` so day boundaries match the operator's.
 */
export async function getDailyActionHistory(
  timezone: string,
  days = 14,
  now: Date = new Date(),
  client: DbClient = prisma,
): Promise<DailyActionPoint[]> {
  const span = Math.min(90, Math.max(1, days));
  const { end } = localDayBounds(timezone, now);
  const from = new Date(end.getTime() - span * 24 * 60 * 60 * 1000);

  const rows = await client.activityLog.findMany({
    where: {
      action: { in: ['CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT'] },
      createdAt: { gte: from, lt: end },
    },
    select: { createdAt: true, result: true },
  });

  const buckets = new Map<string, DailyActionPoint>();
  for (let i = 0; i < span; i += 1) {
    const dayStart = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = localDayKey(timezone, dayStart);
    buckets.set(key, {
      day: key,
      sent: 0,
      alreadyConnected: 0,
      alreadyPending: 0,
      failed: 0,
      requiresReview: 0,
    });
  }

  for (const row of rows) {
    const key = localDayKey(timezone, row.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    switch (row.result) {
      case 'SUCCESS':
        bucket.sent += 1;
        break;
      case 'ALREADY_CONNECTED':
        bucket.alreadyConnected += 1;
        break;
      case 'ALREADY_PENDING':
        bucket.alreadyPending += 1;
        break;
      case 'FAILED':
        bucket.failed += 1;
        break;
      case 'REQUIRES_REVIEW':
        bucket.requiresReview += 1;
        break;
      default:
        break;
    }
  }

  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}
