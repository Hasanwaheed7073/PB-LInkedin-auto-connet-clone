import type {
  BrowserStatus,
  SessionStatus,
  WorkerStatus,
} from '@prisma/client';

import { logActivity, type DbClient } from './activity';
import { prisma } from './db';
import { serverEnv } from './env';
import { openIncident } from './incidents';
import { SYSTEM_STATE_ID, getSystemState } from './safety';

/**
 * Worker registry, exclusive-run lease, and health monitoring.
 *
 * The lease is the reason this system will not double-send: only one worker may
 * hold it, and `claimNextJob` refuses to serve a worker that is not the holder.
 * Requirement 17 - never automatically launch a second worker that could
 * duplicate actions - is enforced here rather than left to operator discipline.
 */

const LEASE_MS = 60_000;

export interface RegisterWorkerInput {
  name: string;
  hostname: string;
  pid: number;
  version?: string;
  /**
   * Take the lease from an existing holder whose heartbeat is still fresh.
   * Requires a deliberate `--force-takeover` on the worker command line; it is
   * never inferred.
   */
  forceTakeover?: boolean;
}

export type RegisterWorkerResult =
  | { ok: true; workerId: string; leaseExpiresAt: Date; tookOverFrom: string | null }
  | {
      ok: false;
      reason: 'LEASE_HELD';
      holder: { id: string; name: string; hostname: string; pid: number; lastHeartbeatAt: Date };
    };

/**
 * Register a worker and try to acquire the exclusive run lease.
 *
 * A stale lease (heartbeat older than `WORKER_HEARTBEAT_STALE_MS`) is taken over
 * automatically, because the previous holder is demonstrably gone. A *fresh*
 * lease is never taken silently.
 */
export async function registerWorker(
  input: RegisterWorkerInput,
): Promise<RegisterWorkerResult> {
  const env = serverEnv();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - env.WORKER_HEARTBEAT_STALE_MS);

  return prisma.$transaction(async (tx) => {
    const state = await getSystemState(tx);

    let tookOverFrom: string | null = null;

    if (state.activeWorkerId) {
      const holder = await tx.worker.findUnique({
        where: { id: state.activeWorkerId },
        select: {
          id: true,
          name: true,
          hostname: true,
          pid: true,
          lastHeartbeatAt: true,
          status: true,
        },
      });

      const holderIsLive =
        holder !== null &&
        holder.status !== 'STOPPED' &&
        holder.lastHeartbeatAt > staleBefore;

      if (holderIsLive && !input.forceTakeover) {
        return {
          ok: false as const,
          reason: 'LEASE_HELD' as const,
          holder: {
            id: holder.id,
            name: holder.name,
            hostname: holder.hostname,
            pid: holder.pid,
            lastHeartbeatAt: holder.lastHeartbeatAt,
          },
        };
      }

      if (holder) {
        tookOverFrom = holder.id;
        await tx.worker.update({
          where: { id: holder.id },
          data: {
            status: 'STOPPED',
            stoppedAt: now,
            lastError: holderIsLive
              ? 'Lease forcibly taken over by a new worker'
              : 'Heartbeat went stale; lease reclaimed',
          },
        });
      }
    }

    const worker = await tx.worker.create({
      data: {
        name: input.name,
        hostname: input.hostname,
        pid: input.pid,
        version: input.version ?? '1.0.0',
        status: 'STARTING',
        lastHeartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      },
      select: { id: true, leaseExpiresAt: true },
    });

    await tx.systemState.update({
      where: { id: SYSTEM_STATE_ID },
      data: { activeWorkerId: worker.id },
    });

    await logActivity(
      {
        action: 'WORKER_REGISTERED',
        result: 'INFO',
        actorType: 'WORKER',
        actorId: worker.id,
        workerId: worker.id,
        message: tookOverFrom
          ? `Worker "${input.name}" registered and took over the run lease.`
          : `Worker "${input.name}" registered and holds the run lease.`,
        metadata: {
          hostname: input.hostname,
          pid: input.pid,
          tookOverFrom,
          forced: input.forceTakeover === true,
        },
      },
      tx,
    );

    return {
      ok: true as const,
      workerId: worker.id,
      leaseExpiresAt: worker.leaseExpiresAt!,
      tookOverFrom,
    };
  });
}

export interface HeartbeatInput {
  workerId: string;
  status?: WorkerStatus;
  browserStatus?: BrowserStatus;
  sessionStatus?: SessionStatus;
  currentJobId?: string | null;
  lastError?: string | null;
}

export type HeartbeatResult =
  | { ok: true; leaseExpiresAt: Date; holdsLease: boolean; controlEpoch: number }
  | { ok: false; reason: 'UNKNOWN_WORKER' };

/**
 * Record a heartbeat and extend the lease.
 *
 * Returns `holdsLease` so a worker that lost the lease (because another took it
 * over) finds out and shuts itself down rather than continuing to act.
 */
export async function recordHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.worker.findUnique({
      where: { id: input.workerId },
      select: { id: true, sessionStatus: true },
    });
    if (!existing) return { ok: false as const, reason: 'UNKNOWN_WORKER' as const };

    await tx.worker.update({
      where: { id: input.workerId },
      data: {
        lastHeartbeatAt: now,
        leaseExpiresAt,
        ...(input.status ? { status: input.status } : {}),
        ...(input.browserStatus ? { browserStatus: input.browserStatus } : {}),
        ...(input.sessionStatus ? { sessionStatus: input.sessionStatus } : {}),
        ...(input.currentJobId !== undefined ? { currentJobId: input.currentJobId } : {}),
        ...(input.lastError !== undefined
          ? { lastError: input.lastError?.slice(0, 1_000) ?? null }
          : {}),
      },
    });

    // Session transitions are audit-worthy: they are how an operator learns the
    // browser fell out of a logged-in state.
    if (input.sessionStatus && input.sessionStatus !== existing.sessionStatus) {
      await logActivity(
        {
          action: 'SESSION_STATUS_CHANGED',
          result: input.sessionStatus === 'CONNECTED' ? 'SUCCESS' : 'REQUIRES_REVIEW',
          actorType: 'WORKER',
          actorId: input.workerId,
          workerId: input.workerId,
          message: `Browser session ${existing.sessionStatus} -> ${input.sessionStatus}`,
        },
        tx,
      );
    }

    const state = await getSystemState(tx);

    return {
      ok: true as const,
      leaseExpiresAt,
      holdsLease: state.activeWorkerId === input.workerId,
      controlEpoch: state.controlEpoch,
    };
  });
}

export async function markWorkerStopped(
  workerId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.worker.updateMany({
      where: { id: workerId, status: { not: 'STOPPED' } },
      data: {
        status: 'STOPPED',
        stoppedAt: new Date(),
        browserStatus: 'CLOSED',
        currentJobId: null,
        lastError: reason.slice(0, 1_000),
      },
    });

    if (updated.count === 0) return;

    const state = await getSystemState(tx);
    if (state.activeWorkerId === workerId) {
      await tx.systemState.update({
        where: { id: SYSTEM_STATE_ID },
        data: { activeWorkerId: null },
      });
    }

    await logActivity(
      {
        action: 'WORKER_STOPPED',
        result: 'INFO',
        actorType: 'WORKER',
        actorId: workerId,
        workerId,
        message: `Worker stopped: ${reason}`,
      },
      tx,
    );
  });
}

export interface WorkerSummary {
  total: number;
  live: number;
  unhealthy: number;
  leaseHolder: {
    id: string;
    name: string;
    hostname: string;
    status: WorkerStatus;
    browserStatus: BrowserStatus;
    sessionStatus: SessionStatus;
    lastHeartbeatAt: Date;
    heartbeatAgeMs: number;
    healthy: boolean;
    currentJobId: string | null;
    jobsProcessed: number;
    jobsFailed: number;
    lastError: string | null;
  } | null;
}

/**
 * Worker health for the dashboard.
 *
 * "Healthy" is defined purely by heartbeat age against
 * `WORKER_HEARTBEAT_STALE_MS`; a worker that stopped reporting is shown as
 * unhealthy rather than optimistically as running.
 */
export async function summarizeWorkers(
  now: Date = new Date(),
  client: DbClient = prisma,
): Promise<WorkerSummary> {
  const env = serverEnv();
  const staleBefore = new Date(now.getTime() - env.WORKER_HEARTBEAT_STALE_MS);

  const [state, total, live, unhealthy] = await Promise.all([
    getSystemState(client),
    client.worker.count(),
    client.worker.count({
      where: { status: { not: 'STOPPED' }, lastHeartbeatAt: { gt: staleBefore } },
    }),
    client.worker.count({
      where: { status: { not: 'STOPPED' }, lastHeartbeatAt: { lte: staleBefore } },
    }),
  ]);

  if (!state.activeWorkerId) return { total, live, unhealthy, leaseHolder: null };

  const holder = await client.worker.findUnique({
    where: { id: state.activeWorkerId },
    select: {
      id: true,
      name: true,
      hostname: true,
      status: true,
      browserStatus: true,
      sessionStatus: true,
      lastHeartbeatAt: true,
      currentJobId: true,
      jobsProcessed: true,
      jobsFailed: true,
      lastError: true,
    },
  });

  if (!holder) return { total, live, unhealthy, leaseHolder: null };

  const heartbeatAgeMs = now.getTime() - holder.lastHeartbeatAt.getTime();

  return {
    total,
    live,
    unhealthy,
    leaseHolder: {
      ...holder,
      heartbeatAgeMs,
      healthy: holder.status !== 'STOPPED' && heartbeatAgeMs <= env.WORKER_HEARTBEAT_STALE_MS,
    },
  };
}

/**
 * Flag workers whose heartbeat went stale and escalate.
 *
 * Called by the dashboard on load and by the reaper. It deliberately does not
 * start a replacement worker: silently launching a second worker is exactly the
 * failure mode requirement 17 rules out.
 */
export async function detectUnhealthyWorkers(now: Date = new Date()): Promise<number> {
  const env = serverEnv();
  const staleBefore = new Date(now.getTime() - env.WORKER_HEARTBEAT_STALE_MS);

  const stale = await prisma.worker.findMany({
    where: {
      status: { notIn: ['STOPPED', 'UNHEALTHY'] },
      lastHeartbeatAt: { lte: staleBefore },
    },
    select: { id: true, name: true, lastHeartbeatAt: true, currentJobId: true },
  });

  for (const worker of stale) {
    await prisma.worker.update({
      where: { id: worker.id },
      data: { status: 'UNHEALTHY' },
    });

    await logActivity({
      action: 'WORKER_HEARTBEAT_STALE',
      result: 'FAILED',
      actorType: 'SYSTEM',
      workerId: worker.id,
      message: `Worker "${worker.name}" stopped sending heartbeats; marked UNHEALTHY.`,
      metadata: {
        lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
        currentJobId: worker.currentJobId,
      },
    });

    await openIncident({
      type: 'WORKER_UNHEALTHY',
      severity: 'WARNING',
      title: `Worker "${worker.name}" is not responding`,
      description:
        `No heartbeat since ${worker.lastHeartbeatAt.toISOString()}. Any job it held will be ` +
        'requeued once its claim lease expires. Check the worker process before restarting it.',
      // Not worker-blocking: a dead worker should not prevent a healthy
      // replacement from being started by hand.
      blocksWorker: false,
      workerId: worker.id,
    });
  }

  return stale.length;
}
