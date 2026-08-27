import type {
  ActivityAction,
  ActivityResult,
  ActorType,
  PageState,
  Prisma,
} from '@prisma/client';

import { prisma } from './db';

/**
 * Immutable activity log.
 *
 * Every state change in the system writes exactly one row here. The table is
 * append-only, enforced by a database trigger (see the
 * `append_only_activity_logs` migration) rather than only by convention - so an
 * accidental `prisma.activityLog.update()` fails loudly instead of quietly
 * rewriting history.
 *
 * `logActivity` accepts a transaction client so an audit row can be written in
 * the same transaction as the change it describes. Nothing that matters is
 * logged outside its transaction.
 */

export type DbClient = Prisma.TransactionClient | typeof prisma;

export interface ActivityInput {
  action: ActivityAction;
  result: ActivityResult;
  actorType?: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  queueJobId?: string | null;
  workerId?: string | null;
  incidentId?: string | null;
  message?: string | null;
  error?: string | null;
  pageState?: PageState | null;
  screenshotPath?: string | null;
  durationMs?: number | null;
  metadata?: Prisma.InputJsonValue | null;
}

/**
 * Keys that must never reach the audit log. Session cookies and tokens are
 * useful to an attacker and useless to an operator, so they are stripped from
 * metadata rather than trusted not to be passed.
 */
const REDACTED_KEYS =
  /(cookie|token|password|secret|authorization|auth|session|li_at|jsessionid|bearer|credential|apikey)/i;

/**
 * Recursively strip sensitive values from metadata before it is persisted.
 * Requirement 21: no authentication cookies or session data in the logs, ever.
 */
export function redactMetadata(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return null as unknown as Prisma.InputJsonValue;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactMetadata(v, depth + 1)) as Prisma.InputJsonValue;
  }

  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.test(key)
        ? ('[redacted]' as Prisma.InputJsonValue)
        : redactMetadata(raw, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') {
    return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function truncateText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export async function logActivity(
  input: ActivityInput,
  client: DbClient = prisma,
): Promise<string> {
  const row = await client.activityLog.create({
    data: {
      action: input.action,
      result: input.result,
      actorType: input.actorType ?? 'SYSTEM',
      actorId: input.actorId ?? null,
      actorName: truncateText(input.actorName, 200),
      campaignId: input.campaignId ?? null,
      leadId: input.leadId ?? null,
      queueJobId: input.queueJobId ?? null,
      workerId: input.workerId ?? null,
      incidentId: input.incidentId ?? null,
      message: truncateText(input.message, 2_000),
      error: truncateText(input.error, 4_000),
      pageState: input.pageState ?? null,
      screenshotPath: truncateText(input.screenshotPath, 500),
      durationMs: input.durationMs ?? null,
      metadata:
        input.metadata === null || input.metadata === undefined
          ? undefined
          : redactMetadata(input.metadata),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Count outreach actions performed in a time range.
 *
 * This is what enforces daily limits. It counts append-only log rows rather
 * than mutable job fields, so a retried job is counted once per real attempt
 * and nothing can be silently reset to buy more budget.
 */
export async function countOutreachActions(
  range: { from: Date; to: Date },
  options: { campaignId?: string } = {},
  client: DbClient = prisma,
): Promise<number> {
  return client.activityLog.count({
    where: {
      action: { in: ['CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT'] },
      createdAt: { gte: range.from, lt: range.to },
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    },
  });
}
