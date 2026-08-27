import type { ActorType } from '@prisma/client';

import { logActivity, type DbClient } from './activity';
import { prisma } from './db';

/**
 * Global safety controls: the emergency stop and the gate every worker must
 * pass before it is allowed to act.
 *
 * The kill switch is a persisted row, not process state, so it survives a
 * restart of the dashboard *and* the worker. A worker that comes back up after
 * a crash finds automation still stopped, which is the correct default.
 */

export const SYSTEM_STATE_ID = 'singleton';

export interface SystemStateView {
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  killSwitchEngagedAt: Date | null;
  killSwitchEngagedBy: string | null;
  activeWorkerId: string | null;
  controlEpoch: number;
  updatedAt: Date;
}

/** Read the singleton, creating it on first use. */
export async function getSystemState(client: DbClient = prisma): Promise<SystemStateView> {
  const row = await client.systemState.upsert({
    where: { id: SYSTEM_STATE_ID },
    create: { id: SYSTEM_STATE_ID },
    update: {},
  });
  return row;
}

export interface EmergencyStopInput {
  reason: string;
  actorType?: ActorType;
  actorId?: string | null;
  actorName?: string | null;
}

export interface EmergencyStopResult {
  campaignsPaused: number;
  jobsCancelled: number;
  workersSignalled: number;
  alreadyEngaged: boolean;
}

/**
 * Engage the emergency stop.
 *
 * Effects, all in one transaction:
 *  - latch the kill switch and bump the control epoch, which is what a polling
 *    worker notices mid-job;
 *  - pause every active campaign, so nothing restarts when the stop is cleared
 *    without an explicit re-activation;
 *  - cancel WAITING jobs so no new work is eligible;
 *  - mark live workers DRAINING.
 *
 * Deliberately *not* done: touching PROCESSING jobs. The worker either reports
 * its own outcome or its claim expires and the job is requeued by the reaper.
 * Rewriting it here would race the worker and risk losing the real result.
 */
export async function engageEmergencyStop(
  input: EmergencyStopInput,
): Promise<EmergencyStopResult> {
  return prisma.$transaction(async (tx) => {
    const current = await getSystemState(tx);

    const [{ count: campaignsPaused }, { count: jobsCancelled }, { count: workersSignalled }] =
      await Promise.all([
        tx.campaign.updateMany({
          where: { OR: [{ active: true }, { status: 'RUNNING' }] },
          data: {
            active: false,
            status: 'PAUSED',
            pausedAt: new Date(),
            pausedBy: input.actorName ?? 'emergency-stop',
            pauseReason: `Emergency stop: ${input.reason}`,
          },
        }),
        tx.queueJob.updateMany({
          where: { status: 'WAITING' },
          data: {
            status: 'CANCELLED',
            error: `Cancelled by emergency stop: ${input.reason}`,
            completedAt: new Date(),
          },
        }),
        tx.worker.updateMany({
          where: { status: { in: ['STARTING', 'IDLE', 'RUNNING', 'PAUSED'] } },
          data: { status: 'DRAINING' },
        }),
      ]);

    await tx.systemState.update({
      where: { id: SYSTEM_STATE_ID },
      data: {
        killSwitchEngaged: true,
        killSwitchReason: input.reason.slice(0, 1_000),
        killSwitchEngagedAt: new Date(),
        killSwitchEngagedBy: input.actorName ?? input.actorId ?? 'system',
        controlEpoch: { increment: 1 },
      },
    });

    await logActivity(
      {
        action: 'EMERGENCY_STOP',
        result: 'SUCCESS',
        actorType: input.actorType ?? 'USER',
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        message: `All automation stopped. ${campaignsPaused} campaign(s) paused, ${jobsCancelled} waiting job(s) cancelled.`,
        metadata: { reason: input.reason, campaignsPaused, jobsCancelled, workersSignalled },
      },
      tx,
    );

    return {
      campaignsPaused,
      jobsCancelled,
      workersSignalled,
      alreadyEngaged: current.killSwitchEngaged,
    };
  });
}

export type ClearStopResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_ENGAGED' }
  | { ok: false; reason: 'BLOCKING_INCIDENTS'; incidentIds: string[]; count: number };

/**
 * Clear the emergency stop.
 *
 * Refused while any blocking incident is still open. This is the property that
 * makes it impossible to shrug off a CAPTCHA or an account restriction by
 * clicking one button: the incident has to be resolved first, deliberately.
 *
 * Clearing the stop does not restart anything. Campaigns stay paused and must
 * be re-activated by hand.
 */
export async function clearEmergencyStop(input: {
  actorId?: string | null;
  actorName?: string | null;
}): Promise<ClearStopResult> {
  return prisma.$transaction(async (tx) => {
    const state = await getSystemState(tx);
    if (!state.killSwitchEngaged) return { ok: false, reason: 'NOT_ENGAGED' } as const;

    const blocking = await tx.incident.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
      select: { id: true },
      take: 50,
    });

    if (blocking.length > 0) {
      return {
        ok: false,
        reason: 'BLOCKING_INCIDENTS',
        incidentIds: blocking.map((i) => i.id),
        count: blocking.length,
      } as const;
    }

    await tx.systemState.update({
      where: { id: SYSTEM_STATE_ID },
      data: {
        killSwitchEngaged: false,
        killSwitchReason: null,
        killSwitchEngagedAt: null,
        killSwitchEngagedBy: null,
        controlEpoch: { increment: 1 },
      },
    });

    await logActivity(
      {
        action: 'EMERGENCY_STOP_CLEARED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        message:
          'Emergency stop cleared. Campaigns remain paused and must be re-activated explicitly.',
      },
      tx,
    );

    return { ok: true } as const;
  });
}

export type WorkerGateReason =
  | 'ALLOWED'
  | 'KILL_SWITCH_ENGAGED'
  | 'BLOCKING_INCIDENT_OPEN'
  | 'NOT_LEASE_HOLDER';

export interface WorkerGate {
  allowed: boolean;
  reason: WorkerGateReason;
  message: string;
  controlEpoch: number;
  killSwitchEngaged: boolean;
  blockingIncidentCount: number;
}

/**
 * The single gate every worker action passes through.
 *
 * Called both when claiming a job and repeatedly while one is in flight, so a
 * stop takes effect mid-job rather than at the next claim.
 */
export async function evaluateWorkerGate(
  workerId: string | null,
  client: DbClient = prisma,
): Promise<WorkerGate> {
  const [state, blockingIncidentCount] = await Promise.all([
    getSystemState(client),
    client.incident.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
    }),
  ]);

  const base = {
    controlEpoch: state.controlEpoch,
    killSwitchEngaged: state.killSwitchEngaged,
    blockingIncidentCount,
  };

  if (state.killSwitchEngaged) {
    return {
      ...base,
      allowed: false,
      reason: 'KILL_SWITCH_ENGAGED',
      message: state.killSwitchReason
        ? `Automation stopped: ${state.killSwitchReason}`
        : 'Automation stopped by emergency stop.',
    };
  }

  if (blockingIncidentCount > 0) {
    return {
      ...base,
      allowed: false,
      reason: 'BLOCKING_INCIDENT_OPEN',
      message: `${blockingIncidentCount} incident(s) require human action before automation can continue.`,
    };
  }

  if (workerId && state.activeWorkerId && state.activeWorkerId !== workerId) {
    return {
      ...base,
      allowed: false,
      reason: 'NOT_LEASE_HOLDER',
      message:
        'Another worker holds the exclusive run lease. Refusing to run a second worker, which could double-send.',
    };
  }

  return { ...base, allowed: true, reason: 'ALLOWED', message: 'Automation permitted.' };
}
