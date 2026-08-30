import type {
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  PageState,
  Prisma,
} from '@prisma/client';

import { logActivity, type DbClient } from './activity';
import { notify } from './notify';
import { prisma } from './db';
import { SYSTEM_STATE_ID } from './safety';

/**
 * Incidents - the human intervention queue.
 *
 * An incident is the record of "automation stopped and needs a person". Opening
 * one is the only mechanism by which the worker escalates, and while any
 * incident with `blocksWorker` is unresolved the worker gate stays shut.
 */

export interface OpenIncidentInput {
  type: IncidentType;
  severity?: IncidentSeverity;
  title: string;
  description: string;
  blocksWorker?: boolean;
  campaignId?: string | null;
  leadId?: string | null;
  queueJobId?: string | null;
  workerId?: string | null;
  pageState?: PageState | null;
  pageUrl?: string | null;
  screenshotPath?: string | null;
  detail?: Prisma.InputJsonValue | null;
  /** Latch the global kill switch as part of opening this incident. */
  engageKillSwitch?: boolean;
}

export interface OpenIncidentResult {
  incidentId: string;
  /** True when an existing unresolved incident was reused instead of a new one created. */
  deduplicated: boolean;
  killSwitchEngaged: boolean;
}

/**
 * Types where a second identical incident adds nothing. A single CAPTCHA wall
 * should not produce fifty rows for the operator to close one at a time, so an
 * unresolved incident of the same type is reused.
 */
const DEDUPLICATED_TYPES: readonly IncidentType[] = [
  'LOGIN_REQUIRED',
  'CAPTCHA',
  'SECURITY_CHALLENGE',
  'ACCOUNT_RESTRICTED',
  'WORKER_UNHEALTHY',
];

/**
 * Open an incident, optionally latching the kill switch in the same
 * transaction. Pausing the affected campaign is included so a single detection
 * cannot leave the campaign nominally running.
 */
export async function openIncident(input: OpenIncidentInput): Promise<OpenIncidentResult> {
  const blocksWorker = input.blocksWorker ?? true;

  const result = await prisma.$transaction(async (tx) => {
    if (DEDUPLICATED_TYPES.includes(input.type)) {
      const existing = await tx.incident.findFirst({
        where: { type: input.type, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        // Re-point the existing incident at the newest evidence without
        // resetting the operator's acknowledgement.
        await tx.incident.update({
          where: { id: existing.id },
          data: {
            leadId: input.leadId ?? undefined,
            queueJobId: input.queueJobId ?? undefined,
            workerId: input.workerId ?? undefined,
            pageUrl: input.pageUrl ?? undefined,
            screenshotPath: input.screenshotPath ?? undefined,
            detail: input.detail ?? undefined,
          },
        });

        const killSwitchEngaged = await maybeEngageKillSwitch(tx, input, existing.id);
        return { incidentId: existing.id, deduplicated: true, killSwitchEngaged };
      }
    }

    const incident = await tx.incident.create({
      data: {
        type: input.type,
        severity: input.severity ?? 'WARNING',
        status: 'OPEN',
        title: input.title.slice(0, 300),
        description: input.description.slice(0, 4_000),
        blocksWorker,
        campaignId: input.campaignId ?? null,
        leadId: input.leadId ?? null,
        queueJobId: input.queueJobId ?? null,
        workerId: input.workerId ?? null,
        pageState: input.pageState ?? null,
        pageUrl: input.pageUrl?.slice(0, 1_000) ?? null,
        screenshotPath: input.screenshotPath ?? null,
        detail: input.detail ?? undefined,
      },
      select: { id: true, campaignId: true },
    });

    // Pause the affected campaign when it is configured to stop on incidents.
    if (incident.campaignId && blocksWorker) {
      const settings = await tx.campaignSettings.findUnique({
        where: { campaignId: incident.campaignId },
        select: { pauseOnIncident: true },
      });
      if (settings?.pauseOnIncident !== false) {
        await tx.campaign.updateMany({
          where: { id: incident.campaignId, status: { in: ['RUNNING', 'READY'] } },
          data: {
            status: 'PAUSED',
            active: false,
            pausedAt: new Date(),
            pausedBy: 'system',
            pauseReason: `Incident: ${input.title}`.slice(0, 500),
          },
        });
      }
    }

    await logActivity(
      {
        action: 'INCIDENT_OPENED',
        result: 'REQUIRES_REVIEW',
        actorType: input.workerId ? 'WORKER' : 'SYSTEM',
        actorId: input.workerId ?? null,
        campaignId: input.campaignId ?? null,
        leadId: input.leadId ?? null,
        queueJobId: input.queueJobId ?? null,
        workerId: input.workerId ?? null,
        incidentId: incident.id,
        message: input.title,
        error: input.description,
        pageState: input.pageState ?? null,
        screenshotPath: input.screenshotPath ?? null,
        metadata: { type: input.type, blocksWorker },
      },
      tx,
    );

    const killSwitchEngaged = await maybeEngageKillSwitch(tx, input, incident.id);
    return { incidentId: incident.id, deduplicated: false, killSwitchEngaged };
  });

  // Alert after the transaction commits, never inside it: a webhook is slow and
  // remote, and holding a database transaction open across it would be a bug in
  // its own right. Deduplicated incidents do not re-alert - one CAPTCHA wall
  // should not page the operator fifty times.
  if (!result.deduplicated) {
    void alertForIncident(input, result);
  }

  return result;
}

/**
 * Fire-and-forget operator alert. Deliberately not awaited by the caller and
 * incapable of throwing: this sits on the failure path, and an alerting problem
 * must never become an incident-reporting problem.
 */
async function alertForIncident(
  input: OpenIncidentInput,
  result: OpenIncidentResult,
): Promise<void> {
  try {
    const blocksWorker = input.blocksWorker ?? true;
    const outcome = await notify({
      severity: blocksWorker ? 'critical' : 'warning',
      title: blocksWorker ? `Automation halted: ${input.title}` : `Incident: ${input.title}`,
      detail: input.description.slice(0, 600),
      fields: {
        Type: input.type,
        'Page state': input.pageState ?? undefined,
        'Blocks worker': blocksWorker ? 'yes' : 'no',
        'Emergency stop': result.killSwitchEngaged ? 'ENGAGED' : 'not engaged',
      },
    });

    if (outcome.attempted && !outcome.delivered) {
      // Worth a log line: a silent alerting failure is the same as no alerting.
      console.warn(`[notify] alert not delivered: ${outcome.reason}`);
    }
  } catch (error) {
    console.warn(`[notify] alerting threw: ${error instanceof Error ? error.message : error}`);
  }
}

async function maybeEngageKillSwitch(
  tx: Prisma.TransactionClient,
  input: OpenIncidentInput,
  incidentId: string,
): Promise<boolean> {
  if (!input.engageKillSwitch) return false;

  await tx.systemState.upsert({
    where: { id: SYSTEM_STATE_ID },
    create: {
      id: SYSTEM_STATE_ID,
      killSwitchEngaged: true,
      killSwitchReason: input.title.slice(0, 1_000),
      killSwitchEngagedAt: new Date(),
      killSwitchEngagedBy: 'worker-safety',
      controlEpoch: 1,
    },
    update: {
      killSwitchEngaged: true,
      killSwitchReason: input.title.slice(0, 1_000),
      killSwitchEngagedAt: new Date(),
      killSwitchEngagedBy: 'worker-safety',
      controlEpoch: { increment: 1 },
    },
  });

  await tx.campaign.updateMany({
    where: { OR: [{ active: true }, { status: 'RUNNING' }] },
    data: {
      active: false,
      status: 'PAUSED',
      pausedAt: new Date(),
      pausedBy: 'worker-safety',
      pauseReason: `Automation halted by incident: ${input.title}`.slice(0, 500),
    },
  });

  await logActivity(
    {
      action: 'EMERGENCY_STOP',
      result: 'REQUIRES_REVIEW',
      actorType: 'WORKER',
      actorId: input.workerId ?? null,
      workerId: input.workerId ?? null,
      incidentId,
      message: `Automation halted automatically: ${input.title}`,
      metadata: { automatic: true, incidentType: input.type },
    },
    tx,
  );

  return true;
}

export type IncidentResolutionAction =
  | 'RESUME'
  | 'SKIP_LEAD'
  | 'BLOCK_LEAD'
  | 'REQUEUE_LEAD'
  | 'STOP_CAMPAIGN';

export interface ResolveIncidentInput {
  incidentId: string;
  action: IncidentResolutionAction;
  note?: string | null;
  actorId?: string | null;
  actorName?: string | null;
}

export type ResolveIncidentResult =
  | { ok: true; leadAction: string; campaignPaused: boolean }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'ALREADY_RESOLVED' };

/**
 * Resolve an incident and decide what happens to the affected lead.
 *
 * Resolving never clears the kill switch on its own - that stays a separate,
 * explicit operator action, so acknowledging a CAPTCHA cannot silently restart
 * automation.
 */
export async function resolveIncident(
  input: ResolveIncidentInput,
): Promise<ResolveIncidentResult> {
  return prisma.$transaction(async (tx) => {
    const incident = await tx.incident.findUnique({
      where: { id: input.incidentId },
      select: {
        id: true,
        status: true,
        type: true,
        title: true,
        leadId: true,
        campaignId: true,
        queueJobId: true,
      },
    });

    if (!incident) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (incident.status === 'RESOLVED') return { ok: false, reason: 'ALREADY_RESOLVED' } as const;

    let leadAction = 'none';
    let campaignPaused = false;

    if (incident.leadId) {
      if (input.action === 'SKIP_LEAD') {
        await tx.lead.update({
          where: { id: incident.leadId },
          data: { status: 'SKIPPED', lastResult: `Skipped by operator: ${incident.type}` },
        });
        await tx.queueJob.updateMany({
          where: { leadId: incident.leadId, status: { in: ['WAITING', 'REQUIRES_REVIEW'] } },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            error: 'Lead skipped by operator during incident resolution',
          },
        });
        leadAction = 'skipped';
      } else if (input.action === 'BLOCK_LEAD') {
        await tx.lead.update({
          where: { id: incident.leadId },
          data: { status: 'BLOCKED', lastResult: `Blocked by operator: ${incident.type}` },
        });
        await tx.queueJob.updateMany({
          where: { leadId: incident.leadId, status: { in: ['WAITING', 'REQUIRES_REVIEW'] } },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            error: 'Lead blocked by operator during incident resolution',
          },
        });
        leadAction = 'blocked';
      } else if (input.action === 'REQUEUE_LEAD') {
        // Only safe because the partial unique index on COMPLETED jobs makes a
        // duplicate send impossible even if this is used in error.
        await tx.lead.update({
          where: { id: incident.leadId },
          data: { status: 'PENDING' },
        });
        if (incident.queueJobId) {
          await tx.queueJob.updateMany({
            where: { id: incident.queueJobId, status: 'REQUIRES_REVIEW' },
            data: {
              status: 'WAITING',
              scheduledFor: new Date(),
              error: null,
              errorClass: 'NONE',
              claimedByWorkerId: null,
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
              startedAt: null,
            },
          });
        }
        leadAction = 'requeued';
      }
    }

    if (input.action === 'STOP_CAMPAIGN' && incident.campaignId) {
      await tx.campaign.update({
        where: { id: incident.campaignId },
        data: {
          status: 'PAUSED',
          active: false,
          pausedAt: new Date(),
          pausedBy: input.actorName ?? 'operator',
          pauseReason: `Stopped during incident resolution: ${incident.title}`.slice(0, 500),
        },
      });
      await tx.queueJob.updateMany({
        where: { campaignId: incident.campaignId, status: 'WAITING' },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          error: 'Campaign stopped by operator during incident resolution',
        },
      });
      campaignPaused = true;
    }

    await tx.incident.update({
      where: { id: incident.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy: input.actorName ?? input.actorId ?? 'operator',
        resolutionNote: input.note?.slice(0, 2_000) ?? null,
        resolutionAction: input.action,
      },
    });

    await logActivity(
      {
        action: 'INCIDENT_RESOLVED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        campaignId: incident.campaignId,
        leadId: incident.leadId,
        queueJobId: incident.queueJobId,
        incidentId: incident.id,
        message: `Incident resolved (${input.action}): ${incident.title}`,
        metadata: { action: input.action, leadAction, campaignPaused, note: input.note ?? null },
      },
      tx,
    );

    return { ok: true, leadAction, campaignPaused } as const;
  });
}

export async function acknowledgeIncident(
  incidentId: string,
  actor: { actorId?: string | null; actorName?: string | null },
  client: DbClient = prisma,
): Promise<boolean> {
  const result = await client.incident.updateMany({
    where: { id: incidentId, status: 'OPEN' },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      acknowledgedBy: actor.actorName ?? actor.actorId ?? 'operator',
    },
  });
  return result.count > 0;
}

export interface IncidentCounts {
  open: number;
  acknowledged: number;
  blocking: number;
  critical: number;
}

export async function countIncidents(client: DbClient = prisma): Promise<IncidentCounts> {
  const [open, acknowledged, blocking, critical] = await Promise.all([
    client.incident.count({ where: { status: 'OPEN' } }),
    client.incident.count({ where: { status: 'ACKNOWLEDGED' } }),
    client.incident.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
    }),
    client.incident.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'CRITICAL' },
    }),
  ]);
  return { open, acknowledged, blocking, critical };
}

export const INCIDENT_STATUS_ORDER: readonly IncidentStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
];
