import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openIncident, resolveIncident } from '@/lib/incidents';
import { claimNextJob } from '@/lib/queue';
import {
  clearEmergencyStop,
  engageEmergencyStop,
  evaluateWorkerGate,
  getSystemState,
} from '@/lib/safety';

import {
  assertDatabaseReady,
  createCampaignFixture,
  createLeadFixture,
  createQueueJobFixture,
  createWorkerFixture,
  disconnectTestDb,
  isPgliteBackend,
  resetDatabase,
  testDb,
} from '../helpers/db';

// Resolved once at collection time so `it.skipIf` can use it. See the note on
// the append-only tests below.
const pglite = await isPgliteBackend();

/**
 * Emergency stop, the worker gate, and the human intervention flow.
 *
 * The properties that matter: stopping always works and is always recorded;
 * clearing the stop is refused while a blocking incident is open; and resolving
 * an incident never restarts automation on its own.
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

describe('engageEmergencyStop', () => {
  it('latches the switch, pauses campaigns and cancels waiting jobs', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    for (let i = 0; i < 3; i += 1) {
      const lead = await createLeadFixture({ campaignId: campaign.id });
      await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    }

    const result = await engageEmergencyStop({ reason: 'LinkedIn showed a warning' });

    expect(result.campaignsPaused).toBe(1);
    expect(result.jobsCancelled).toBe(3);

    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(true);
    expect(state.killSwitchReason).toBe('LinkedIn showed a warning');
    expect(state.controlEpoch).toBeGreaterThan(0);

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.active).toBe(false);
    expect(stored.status).toBe('PAUSED');

    const jobs = await testDb().queueJob.findMany();
    expect(jobs.every((j) => j.status === 'CANCELLED')).toBe(true);
  });

  it('leaves an in-flight job alone so its real outcome is not lost', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const claim = await claimNextJob({ workerId: worker.id });
    expect(claim.status).toBe('CLAIMED');

    await engageEmergencyStop({ reason: 'stop now' });

    const jobs = await testDb().queueJob.findMany();
    // Still PROCESSING: the worker reports its own outcome, or the reaper
    // requeues it. Rewriting it here would race the worker.
    expect(jobs[0]!.status).toBe('PROCESSING');
  });

  it('marks live workers as draining', async () => {
    const worker = await createWorkerFixture();
    await testDb().worker.update({ where: { id: worker.id }, data: { status: 'RUNNING' } });

    await engageEmergencyStop({ reason: 'x' });

    const stored = await testDb().worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(stored.status).toBe('DRAINING');
  });

  it('records the stop in the immutable audit log', async () => {
    await engageEmergencyStop({
      reason: 'operator pressed stop',
      actorName: 'Test Operator',
    });

    const log = await testDb().activityLog.findFirst({ where: { action: 'EMERGENCY_STOP' } });
    expect(log).not.toBeNull();
    expect(log?.actorName).toBe('Test Operator');
    expect(log?.metadata).toMatchObject({ reason: 'operator pressed stop' });
  });

  it('is idempotent - stopping twice is safe and reports it was already engaged', async () => {
    await engageEmergencyStop({ reason: 'first' });
    const second = await engageEmergencyStop({ reason: 'second' });

    expect(second.alreadyEngaged).toBe(true);
    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(true);
    expect(state.killSwitchReason).toBe('second');
  });
});

describe('clearEmergencyStop', () => {
  it('clears the switch when nothing is blocking', async () => {
    await engageEmergencyStop({ reason: 'test' });

    const result = await clearEmergencyStop({ actorName: 'Operator' });
    expect(result.ok).toBe(true);

    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(false);
    expect(state.killSwitchReason).toBeNull();
  });

  it('does NOT reactivate campaigns', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    await engageEmergencyStop({ reason: 'test' });
    await clearEmergencyStop({ actorName: 'Operator' });

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.active).toBe(false);
    expect(stored.status).toBe('PAUSED');
  });

  it('is REFUSED while a blocking incident is open', async () => {
    await engageEmergencyStop({ reason: 'captcha' });
    await openIncident({
      type: 'CAPTCHA',
      severity: 'CRITICAL',
      title: 'CAPTCHA detected',
      description: 'A CAPTCHA was presented.',
      blocksWorker: true,
    });

    const result = await clearEmergencyStop({ actorName: 'Operator' });

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'BLOCKING_INCIDENTS') {
      throw new Error('expected the clear to be refused for blocking incidents');
    }
    expect(result.count).toBe(1);
    expect(result.incidentIds).toHaveLength(1);

    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(true);
  });

  it('can be cleared once the blocking incident is resolved', async () => {
    await engageEmergencyStop({ reason: 'captcha' });
    const opened = await openIncident({
      type: 'CAPTCHA',
      severity: 'CRITICAL',
      title: 'CAPTCHA detected',
      description: 'A CAPTCHA was presented.',
      blocksWorker: true,
    });

    expect((await clearEmergencyStop({})).ok).toBe(false);

    await resolveIncident({
      incidentId: opened.incidentId,
      action: 'RESUME',
      note: 'Solved it by hand',
    });

    expect((await clearEmergencyStop({})).ok).toBe(true);
  });

  it('reports when the stop was not engaged', async () => {
    const result = await clearEmergencyStop({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_ENGAGED');
  });

  it('records the clearance in the audit log', async () => {
    await engageEmergencyStop({ reason: 'test' });
    await clearEmergencyStop({ actorName: 'Operator' });

    const log = await testDb().activityLog.findFirst({
      where: { action: 'EMERGENCY_STOP_CLEARED' },
    });
    expect(log?.actorName).toBe('Operator');
  });
});

describe('evaluateWorkerGate', () => {
  it('permits a healthy lease holder', async () => {
    const worker = await createWorkerFixture();
    const gate = await evaluateWorkerGate(worker.id);
    expect(gate).toMatchObject({ allowed: true, reason: 'ALLOWED' });
  });

  it('refuses everything while the stop is engaged', async () => {
    const worker = await createWorkerFixture();
    await engageEmergencyStop({ reason: 'stop' });

    const gate = await evaluateWorkerGate(worker.id);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('KILL_SWITCH_ENGAGED');
    expect(gate.message).toContain('stop');
  });

  it('refuses while a blocking incident is open', async () => {
    const worker = await createWorkerFixture();
    await openIncident({
      type: 'SECURITY_CHALLENGE',
      title: 'Challenge',
      description: 'x',
      blocksWorker: true,
    });

    const gate = await evaluateWorkerGate(worker.id);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('BLOCKING_INCIDENT_OPEN');
    expect(gate.blockingIncidentCount).toBe(1);
  });

  it('permits when the only open incident is non-blocking', async () => {
    const worker = await createWorkerFixture();
    await openIncident({
      type: 'PROFILE_UNPROCESSABLE',
      title: 'One odd profile',
      description: 'x',
      blocksWorker: false,
    });

    const gate = await evaluateWorkerGate(worker.id);
    expect(gate.allowed).toBe(true);
  });

  it('refuses a worker that does not hold the lease', async () => {
    await createWorkerFixture('holder');
    const other = await testDb().worker.create({
      data: { name: 'other', hostname: 'h', pid: 2, status: 'IDLE' },
    });

    const gate = await evaluateWorkerGate(other.id);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('NOT_LEASE_HOLDER');
  });
});

describe('openIncident', () => {
  it('pauses the affected campaign when configured to', async () => {
    const campaign = await createCampaignFixture({
      active: true,
      status: 'RUNNING',
      pauseOnIncident: true,
    });

    await openIncident({
      type: 'SECURITY_CHALLENGE',
      title: 'Challenge',
      description: 'x',
      blocksWorker: true,
      campaignId: campaign.id,
    });

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('PAUSED');
    expect(stored.active).toBe(false);
  });

  it('leaves the campaign running when pauseOnIncident is off', async () => {
    const campaign = await createCampaignFixture({
      active: true,
      status: 'RUNNING',
      pauseOnIncident: false,
    });

    await openIncident({
      type: 'PROFILE_UNPROCESSABLE',
      title: 'One odd profile',
      description: 'x',
      blocksWorker: false,
      campaignId: campaign.id,
    });

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('RUNNING');
  });

  it('deduplicates repeated CAPTCHA incidents instead of flooding the queue', async () => {
    const first = await openIncident({
      type: 'CAPTCHA',
      title: 'CAPTCHA',
      description: 'first',
      blocksWorker: true,
    });
    const second = await openIncident({
      type: 'CAPTCHA',
      title: 'CAPTCHA',
      description: 'second',
      blocksWorker: true,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.incidentId).toBe(first.incidentId);
    expect(await testDb().incident.count()).toBe(1);
  });

  it('does not deduplicate per-lead profile problems', async () => {
    const campaign = await createCampaignFixture();
    const a = await createLeadFixture({ campaignId: campaign.id });
    const b = await createLeadFixture({ campaignId: campaign.id });

    await openIncident({
      type: 'PROFILE_UNPROCESSABLE',
      title: 'A',
      description: 'x',
      blocksWorker: false,
      leadId: a.id,
    });
    await openIncident({
      type: 'PROFILE_UNPROCESSABLE',
      title: 'B',
      description: 'x',
      blocksWorker: false,
      leadId: b.id,
    });

    expect(await testDb().incident.count()).toBe(2);
  });

  it('latches the kill switch when asked', async () => {
    await openIncident({
      type: 'ACCOUNT_RESTRICTED',
      title: 'Restricted',
      description: 'x',
      blocksWorker: true,
      engageKillSwitch: true,
    });

    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(true);
  });
});

describe('resolveIncident', () => {
  async function incidentWithLead() {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id, status: 'REQUIRES_REVIEW' });
    const job = await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'REQUIRES_REVIEW',
    });
    const opened = await openIncident({
      type: 'UNEXPECTED_PAGE',
      title: 'Unknown page',
      description: 'x',
      blocksWorker: true,
      campaignId: campaign.id,
      leadId: lead.id,
      queueJobId: job.id,
    });
    return { campaign, lead, job, incidentId: opened.incidentId };
  }

  it('SKIP_LEAD skips the lead and cancels its job', async () => {
    const { lead, job, incidentId } = await incidentWithLead();

    const result = await resolveIncident({ incidentId, action: 'SKIP_LEAD' });
    expect(result.ok).toBe(true);

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('SKIPPED');

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(storedJob.status).toBe('CANCELLED');
  });

  it('BLOCK_LEAD blocks the lead permanently', async () => {
    const { lead, incidentId } = await incidentWithLead();
    await resolveIncident({ incidentId, action: 'BLOCK_LEAD' });

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('BLOCKED');
  });

  it('REQUEUE_LEAD returns the job to WAITING', async () => {
    const { lead, job, incidentId } = await incidentWithLead();
    await resolveIncident({ incidentId, action: 'REQUEUE_LEAD' });

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(storedJob.status).toBe('WAITING');
    expect(storedJob.claimToken).toBeNull();

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('PENDING');
  });

  it('STOP_CAMPAIGN pauses the campaign and clears its queue', async () => {
    const { campaign, incidentId } = await incidentWithLead();
    await testDb().campaign.update({
      where: { id: campaign.id },
      data: { status: 'RUNNING', active: true },
    });

    const result = await resolveIncident({ incidentId, action: 'STOP_CAMPAIGN' });
    expect(result.ok && result.campaignPaused).toBe(true);

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('PAUSED');
  });

  it('RESUME resolves without touching the lead', async () => {
    const { lead, incidentId } = await incidentWithLead();
    await resolveIncident({ incidentId, action: 'RESUME' });

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('REQUIRES_REVIEW');

    const incident = await testDb().incident.findUniqueOrThrow({ where: { id: incidentId } });
    expect(incident.status).toBe('RESOLVED');
  });

  it('does NOT clear the kill switch', async () => {
    const { incidentId } = await incidentWithLead();
    await engageEmergencyStop({ reason: 'captcha' });

    await resolveIncident({ incidentId, action: 'RESUME' });

    const state = await getSystemState();
    expect(state.killSwitchEngaged).toBe(true);
  });

  it('releases the worker gate once resolved', async () => {
    const worker = await createWorkerFixture();
    const { incidentId } = await incidentWithLead();

    expect((await evaluateWorkerGate(worker.id)).allowed).toBe(false);

    await resolveIncident({ incidentId, action: 'SKIP_LEAD' });

    expect((await evaluateWorkerGate(worker.id)).allowed).toBe(true);
  });

  it('cannot be resolved twice', async () => {
    const { incidentId } = await incidentWithLead();
    await resolveIncident({ incidentId, action: 'RESUME' });

    const second = await resolveIncident({ incidentId, action: 'RESUME' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('ALREADY_RESOLVED');
  });

  it('records the resolution in the audit log', async () => {
    const { incidentId } = await incidentWithLead();
    await resolveIncident({
      incidentId,
      action: 'SKIP_LEAD',
      note: 'Profile is a company page',
      actorName: 'Operator',
    });

    const log = await testDb().activityLog.findFirst({ where: { action: 'INCIDENT_RESOLVED' } });
    expect(log?.actorName).toBe('Operator');
    expect(log?.metadata).toMatchObject({ action: 'SKIP_LEAD' });
  });
});

describe('the activity log really is append-only', () => {
  /**
   * The append-only trigger is verified by `npm run db:verify`, which probes it
   * on a single raw connection using savepoints, and which passes.
   *
   * It cannot be probed from inside this suite when the target is PGlite: the
   * trigger raises an exception, and PGlite resets the whole WASM instance
   * unless the statement is inside a savepoint - but containing it in a
   * savepoint needs a raw connection, and PGlite allows only one, which Prisma
   * already holds. So on PGlite these two skip themselves with this note rather
   * than failing or asserting nothing. Against a real PostgreSQL they run.
   */
  it.skipIf(pglite)('rejects an UPDATE at the database level', async () => {
    const id = await testDb()
      .activityLog.create({
        data: { action: 'CONNECT', result: 'SUCCESS', message: 'original' },
        select: { id: true },
      })
      .then((row) => row.id);

    await expect(
      testDb().activityLog.update({ where: { id }, data: { message: 'tampered' } }),
    ).rejects.toThrow();

    const stored = await testDb().activityLog.findUniqueOrThrow({ where: { id } });
    expect(stored.message).toBe('original');
  });

  it.skipIf(pglite)('rejects a DELETE at the database level', async () => {
    const id = await testDb()
      .activityLog.create({
        data: { action: 'CONNECT', result: 'SUCCESS' },
        select: { id: true },
      })
      .then((row) => row.id);

    await expect(testDb().activityLog.delete({ where: { id } })).rejects.toThrow();
    expect(await testDb().activityLog.count({ where: { id } })).toBe(1);
  });

  it('redacts sensitive keys from metadata before storing', async () => {
    const { logActivity } = await import('@/lib/activity');

    const id = await logActivity({
      action: 'CONNECT',
      result: 'SUCCESS',
      metadata: {
        safe: 'keep me',
        cookie: 'li_at=SECRETVALUE',
        nested: { authorization: 'Bearer abc', fine: 1 },
      },
    });

    const stored = await testDb().activityLog.findUniqueOrThrow({ where: { id } });
    expect(stored.metadata).toMatchObject({
      safe: 'keep me',
      cookie: '[redacted]',
      nested: { authorization: '[redacted]', fine: 1 },
    });
  });
});
