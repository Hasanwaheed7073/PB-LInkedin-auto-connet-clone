import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hostname } from 'node:os';

import { claimNextJob } from '@/lib/queue';
import { getSystemState } from '@/lib/safety';
import {
  detectUnhealthyWorkers,
  markWorkerStopped,
  recordHeartbeat,
  registerWorker,
  summarizeWorkers,
} from '@/lib/workers';

import {
  assertDatabaseReady,
  createCampaignFixture,
  createLeadFixture,
  createQueueJobFixture,
  disconnectTestDb,
  resetDatabase,
  testDb,
} from '../helpers/db';

/**
 * Worker registration, the exclusive run lease, and heartbeat health.
 *
 * The property that matters: a second worker must never be able to run
 * concurrently with a live one, because two workers would double the send rate
 * and could contact the same person twice.
 */

beforeAll(async () => {
  await assertDatabaseReady();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await resetDatabase();
});

function registration(name: string, forceTakeover = false) {
  return {
    name,
    hostname: hostname(),
    pid: process.pid,
    version: '1.0.0',
    forceTakeover,
  };
}

describe('registerWorker', () => {
  it('registers the first worker and grants the lease', async () => {
    const result = await registerWorker(registration('worker-1'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tookOverFrom).toBeNull();

    const state = await getSystemState();
    expect(state.activeWorkerId).toBe(result.workerId);
  });

  it('REFUSES a second worker while the first is alive', async () => {
    const first = await registerWorker(registration('worker-1'));
    expect(first.ok).toBe(true);

    const second = await registerWorker(registration('worker-2'));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('LEASE_HELD');
    expect(second.holder.name).toBe('worker-1');

    // The lease is unchanged.
    const state = await getSystemState();
    if (first.ok) expect(state.activeWorkerId).toBe(first.workerId);
  });

  it('allows a takeover only when explicitly forced', async () => {
    const first = await registerWorker(registration('worker-1'));
    expect(first.ok).toBe(true);

    const forced = await registerWorker(registration('worker-2', true));

    expect(forced.ok).toBe(true);
    if (!forced.ok || !first.ok) return;
    expect(forced.tookOverFrom).toBe(first.workerId);

    const state = await getSystemState();
    expect(state.activeWorkerId).toBe(forced.workerId);

    // The displaced worker is marked stopped so it cannot keep acting.
    const old = await testDb().worker.findUniqueOrThrow({ where: { id: first.workerId } });
    expect(old.status).toBe('STOPPED');
  });

  it('reclaims a stale lease automatically', async () => {
    const first = await registerWorker(registration('worker-1'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Age the heartbeat past the staleness threshold (45s in the test env).
    await testDb().worker.update({
      where: { id: first.workerId },
      data: { lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });

    const second = await registerWorker(registration('worker-2'));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tookOverFrom).toBe(first.workerId);
  });

  it('records registration in the audit log', async () => {
    await registerWorker(registration('worker-1'));

    const log = await testDb().activityLog.findFirst({ where: { action: 'WORKER_REGISTERED' } });
    expect(log).not.toBeNull();
    expect(log?.message).toContain('worker-1');
  });
});

describe('recordHeartbeat', () => {
  it('extends the lease and reports the worker still holds it', async () => {
    const registered = await registerWorker(registration('worker-1'));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await recordHeartbeat({
      workerId: registered.workerId,
      status: 'RUNNING',
      browserStatus: 'OPEN',
      sessionStatus: 'CONNECTED',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdsLease).toBe(true);
    expect(result.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const stored = await testDb().worker.findUniqueOrThrow({
      where: { id: registered.workerId },
    });
    expect(stored.status).toBe('RUNNING');
    expect(stored.sessionStatus).toBe('CONNECTED');
  });

  it('tells a displaced worker it no longer holds the lease', async () => {
    const first = await registerWorker(registration('worker-1'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await registerWorker(registration('worker-2', true));

    const result = await recordHeartbeat({ workerId: first.workerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // This is the signal that makes the old worker shut itself down.
    expect(result.holdsLease).toBe(false);
  });

  it('logs a session status change', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await recordHeartbeat({ workerId: registered.workerId, sessionStatus: 'CONNECTED' });
    await recordHeartbeat({ workerId: registered.workerId, sessionStatus: 'CHALLENGE_DETECTED' });

    const logs = await testDb().activityLog.findMany({
      where: { action: 'SESSION_STATUS_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect(logs[1]?.message).toContain('CHALLENGE_DETECTED');
  });

  it('does not log when the session status is unchanged', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await recordHeartbeat({ workerId: registered.workerId, sessionStatus: 'CONNECTED' });
    await recordHeartbeat({ workerId: registered.workerId, sessionStatus: 'CONNECTED' });

    const logs = await testDb().activityLog.findMany({
      where: { action: 'SESSION_STATUS_CHANGED' },
    });
    expect(logs).toHaveLength(1);
  });

  it('reports an unknown worker rather than throwing', async () => {
    const result = await recordHeartbeat({ workerId: 'cxxxxxxxxxxxxxxxxxxxxxxxx' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNKNOWN_WORKER');
  });
});

describe('detectUnhealthyWorkers', () => {
  it('flags a worker whose heartbeat went stale and opens an incident', async () => {
    const registered = await registerWorker(registration('worker-1'));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    await testDb().worker.update({
      where: { id: registered.workerId },
      data: { status: 'RUNNING', lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });

    const flagged = await detectUnhealthyWorkers();
    expect(flagged).toBe(1);

    const stored = await testDb().worker.findUniqueOrThrow({
      where: { id: registered.workerId },
    });
    expect(stored.status).toBe('UNHEALTHY');

    const incident = await testDb().incident.findFirst({ where: { type: 'WORKER_UNHEALTHY' } });
    expect(incident).not.toBeNull();
    // A dead worker must not block a healthy replacement from starting.
    expect(incident?.blocksWorker).toBe(false);
  });

  it('leaves a healthy worker alone', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await recordHeartbeat({ workerId: registered.workerId, status: 'RUNNING' });

    expect(await detectUnhealthyWorkers()).toBe(0);
  });

  it('does not re-flag an already unhealthy worker', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await testDb().worker.update({
      where: { id: registered.workerId },
      data: { status: 'RUNNING', lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });

    expect(await detectUnhealthyWorkers()).toBe(1);
    expect(await detectUnhealthyWorkers()).toBe(0);
  });
});

describe('markWorkerStopped', () => {
  it('releases the lease so a replacement needs no force flag', async () => {
    const first = await registerWorker(registration('worker-1'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await markWorkerStopped(first.workerId, 'Received SIGINT');

    const state = await getSystemState();
    expect(state.activeWorkerId).toBeNull();

    const second = await registerWorker(registration('worker-2'));
    expect(second.ok).toBe(true);
  });

  it('records the shutdown reason', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await markWorkerStopped(registered.workerId, 'Session check failed: LOGIN_REQUIRED');

    const log = await testDb().activityLog.findFirst({ where: { action: 'WORKER_STOPPED' } });
    expect(log?.message).toContain('LOGIN_REQUIRED');
  });

  it('is idempotent', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await markWorkerStopped(registered.workerId, 'first');
    await markWorkerStopped(registered.workerId, 'second');

    const logs = await testDb().activityLog.findMany({ where: { action: 'WORKER_STOPPED' } });
    expect(logs).toHaveLength(1);
  });
});

describe('summarizeWorkers', () => {
  it('reports the lease holder and its health', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;
    await recordHeartbeat({ workerId: registered.workerId, status: 'IDLE' });

    const summary = await summarizeWorkers();
    expect(summary.leaseHolder?.name).toBe('worker-1');
    expect(summary.leaseHolder?.healthy).toBe(true);
    expect(summary.live).toBe(1);
  });

  it('reports a stale holder as unhealthy', async () => {
    const registered = await registerWorker(registration('worker-1'));
    if (!registered.ok) return;

    await testDb().worker.update({
      where: { id: registered.workerId },
      data: { lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });

    const summary = await summarizeWorkers();
    expect(summary.leaseHolder?.healthy).toBe(false);
    expect(summary.unhealthy).toBe(1);
  });

  it('reports no holder when nothing is running', async () => {
    const summary = await summarizeWorkers();
    expect(summary.leaseHolder).toBeNull();
  });
});

describe('a non-lease-holder cannot do work', () => {
  it('is refused at claim time', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    const holder = await registerWorker(registration('holder'));
    expect(holder.ok).toBe(true);

    const intruder = await testDb().worker.create({
      data: { name: 'intruder', hostname: 'elsewhere', pid: 999, status: 'IDLE' },
    });

    const outcome = await claimNextJob({ workerId: intruder.id });
    expect(outcome.status).toBe('BLOCKED');

    // And the job is untouched.
    const job = await testDb().queueJob.findFirstOrThrow();
    expect(job.status).toBe('WAITING');
    expect(job.attempts).toBe(0);
  });
});
