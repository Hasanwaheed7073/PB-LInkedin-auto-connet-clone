import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimNextJob,
  completeJob,
  evaluateCampaignEligibility,
  failJob,
  generateQueueForCampaign,
  getQueueCounts,
  reapExpiredClaims,
} from '@/lib/queue';
import { engageEmergencyStop } from '@/lib/safety';

import {
  assertDatabaseReady,
  createCampaignFixture,
  createLeadFixture,
  createQueueJobFixture,
  createWorkerFixture,
  disconnectTestDb,
  resetDatabase,
  testDb,
} from '../helpers/db';

/**
 * Queue generation, claiming, completion and failure - against a real
 * PostgreSQL.
 *
 * This is the most safety-critical code in the project, so the tests here are
 * about what must NOT happen: no duplicate invitation, no job lost to a
 * restart, no work done while stopped, no retry of a security state.
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

describe('generateQueueForCampaign', () => {
  it('queues one job per pending lead', async () => {
    const campaign = await createCampaignFixture();
    for (let i = 0; i < 5; i += 1) {
      await createLeadFixture({ campaignId: campaign.id });
    }

    const result = await generateQueueForCampaign({ campaignId: campaign.id });

    expect(result.created).toBe(5);
    expect(await testDb().queueJob.count()).toBe(5);
  });

  it('is idempotent - running it twice does not double-queue anyone', async () => {
    const campaign = await createCampaignFixture();
    for (let i = 0; i < 4; i += 1) {
      await createLeadFixture({ campaignId: campaign.id });
    }

    const first = await generateQueueForCampaign({ campaignId: campaign.id });
    const second = await generateQueueForCampaign({ campaignId: campaign.id });

    expect(first.created).toBe(4);
    expect(second.created).toBe(0);
    expect(await testDb().queueJob.count()).toBe(4);
  });

  it('never queues a lead that already has an invitation recorded', async () => {
    const campaign = await createCampaignFixture();
    await createLeadFixture({ campaignId: campaign.id, status: 'PENDING' });
    await createLeadFixture({
      campaignId: campaign.id,
      status: 'SENT',
      invitationSentAt: new Date(),
    });

    const result = await generateQueueForCampaign({ campaignId: campaign.id });
    expect(result.created).toBe(1);
  });

  it('does not queue leads from another campaign', async () => {
    const mine = await createCampaignFixture({ name: 'mine' });
    const theirs = await createCampaignFixture({ name: 'theirs' });
    await createLeadFixture({ campaignId: mine.id });
    await createLeadFixture({ campaignId: theirs.id });
    await createLeadFixture({ campaignId: null });

    const result = await generateQueueForCampaign({ campaignId: mine.id });
    expect(result.created).toBe(1);
  });

  it('re-queues a lead whose previous attempt FAILED', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id, status: 'FAILED' });
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'FAILED',
    });

    const result = await generateQueueForCampaign({ campaignId: campaign.id });
    expect(result.created).toBe(1);
  });

  it('spreads scheduled times across the operating window', async () => {
    const campaign = await createCampaignFixture({ minActionDelaySeconds: 60, maxActionDelaySeconds: 60 });
    for (let i = 0; i < 3; i += 1) await createLeadFixture({ campaignId: campaign.id });

    await generateQueueForCampaign({
      campaignId: campaign.id,
      now: new Date('2026-08-26T10:00:00Z'),
      jitter: () => 0.5,
    });

    const jobs = await testDb().queueJob.findMany({ orderBy: { scheduledFor: 'asc' } });
    expect(jobs).toHaveLength(3);
    expect(jobs[1]!.scheduledFor.getTime() - jobs[0]!.scheduledFor.getTime()).toBe(60_000);
  });

  it('writes an audit record', async () => {
    const campaign = await createCampaignFixture();
    await createLeadFixture({ campaignId: campaign.id });

    await generateQueueForCampaign({ campaignId: campaign.id });

    const log = await testDb().activityLog.findFirst({ where: { action: 'QUEUE_GENERATED' } });
    expect(log).not.toBeNull();
    expect(log?.campaignId).toBe(campaign.id);
  });
});

describe('claimNextJob', () => {
  it('claims an eligible job and marks it PROCESSING', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    const job = await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });

    expect(outcome.status).toBe('CLAIMED');
    if (outcome.status !== 'CLAIMED') return;

    expect(outcome.job.jobId).toBe(job.id);
    expect(outcome.job.claimToken).toBeTruthy();
    expect(outcome.job.attempts).toBe(1);
    expect(outcome.job.lead.linkedinUrl).toBe(lead.linkedinUrl);

    const stored = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe('PROCESSING');
    expect(stored.claimedByWorkerId).toBe(worker.id);
    expect(stored.claimExpiresAt).not.toBeNull();

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('PROCESSING');
  });

  it('returns EMPTY when there is nothing to do', async () => {
    await createCampaignFixture();
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
  });

  it('never claims the same job twice', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const first = await claimNextJob({ workerId: worker.id });
    const second = await claimNextJob({ workerId: worker.id });

    expect(first.status).toBe('CLAIMED');
    expect(second.status).toBe('EMPTY');
  });

  it('does not claim from an inactive campaign', async () => {
    const campaign = await createCampaignFixture({ active: false, status: 'PAUSED' });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
  });

  it('does not claim a job scheduled for the future', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      scheduledFor: new Date(Date.now() + 60 * 60_000),
    });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
    if (outcome.status === 'EMPTY') expect(outcome.reason).toBe('NOT_YET_SCHEDULED');
  });

  it('does not claim a job for a lead already sent an invitation', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({
      campaignId: campaign.id,
      status: 'PENDING',
      invitationSentAt: new Date(),
    });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
  });

  it('does not claim a job for a lead already resolved for that action', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    // A COMPLETED job exists; a stray WAITING job must not be actioned.
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'COMPLETED',
    });
    await testDb().queueJob.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        action: 'MESSAGE', // different action so the live-job index allows the row
        status: 'WAITING',
        scheduledFor: new Date(Date.now() - 1_000),
      },
    });

    const worker = await createWorkerFixture();
    const outcome = await claimNextJob({ workerId: worker.id });

    // The MESSAGE job is claimable in principle, but the CONNECT one is resolved.
    if (outcome.status === 'CLAIMED') {
      expect(outcome.job.action).toBe('MESSAGE');
    }
    const connectJobs = await testDb().queueJob.findMany({ where: { action: 'CONNECT' } });
    expect(connectJobs.every((j) => j.status === 'COMPLETED')).toBe(true);
  });

  it('respects the campaign daily limit using the immutable activity log', async () => {
    const campaign = await createCampaignFixture({ dailyLimit: 2 });
    for (let i = 0; i < 4; i += 1) await createLeadFixture({ campaignId: campaign.id });
    await generateQueueForCampaign({ campaignId: campaign.id });
    const worker = await createWorkerFixture();

    // Two actions already logged today for this campaign.
    for (let i = 0; i < 2; i += 1) {
      await testDb().activityLog.create({
        data: { action: 'CONNECT', result: 'SUCCESS', campaignId: campaign.id },
      });
    }

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
    if (outcome.status === 'EMPTY') expect(outcome.reason).toBe('DAILY_LIMIT_REACHED');
  });

  it('respects the global daily limit across campaigns', async () => {
    const a = await createCampaignFixture({ name: 'a', dailyLimit: 100 });
    const b = await createCampaignFixture({ name: 'b', dailyLimit: 100 });
    await createLeadFixture({ campaignId: a.id });
    await createLeadFixture({ campaignId: b.id });
    await generateQueueForCampaign({ campaignId: a.id });
    await generateQueueForCampaign({ campaignId: b.id });
    const worker = await createWorkerFixture();

    // GLOBAL_DAILY_ACTION_LIMIT is 40 in the test env.
    for (let i = 0; i < 40; i += 1) {
      await testDb().activityLog.create({
        data: { action: 'CONNECT', result: 'SUCCESS', campaignId: a.id },
      });
    }

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('EMPTY');
    if (outcome.status === 'EMPTY') expect(outcome.reason).toBe('GLOBAL_DAILY_LIMIT_REACHED');
  });

  it('refuses to serve a worker that does not hold the run lease', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    await createWorkerFixture('holder');
    const intruder = await testDb().worker.create({
      data: { name: 'intruder', hostname: 'other', pid: 1, status: 'IDLE' },
    });

    const outcome = await claimNextJob({ workerId: intruder.id });
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.reason).toBe('NOT_LEASE_HOLDER');
  });

  it('is blocked while the emergency stop is engaged', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    await engageEmergencyStop({ reason: 'test stop' });

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.reason).toBe('KILL_SWITCH_ENGAGED');
  });

  it('is blocked while a blocking incident is unresolved', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    await testDb().incident.create({
      data: {
        type: 'CAPTCHA',
        severity: 'CRITICAL',
        status: 'OPEN',
        title: 'CAPTCHA',
        description: 'test',
        blocksWorker: true,
      },
    });

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.reason).toBe('BLOCKING_INCIDENT_OPEN');
  });

  it('claims in priority then schedule order', async () => {
    const campaign = await createCampaignFixture();
    const normal = await createLeadFixture({ campaignId: campaign.id });
    const urgent = await createLeadFixture({ campaignId: campaign.id });

    await createQueueJobFixture({
      leadId: normal.id,
      campaignId: campaign.id,
      scheduledFor: new Date(Date.now() - 10_000),
      priority: 100,
    });
    await createQueueJobFixture({
      leadId: urgent.id,
      campaignId: campaign.id,
      scheduledFor: new Date(Date.now() - 1_000),
      priority: -100,
    });

    const worker = await createWorkerFixture();
    const outcome = await claimNextJob({ workerId: worker.id });

    expect(outcome.status).toBe('CLAIMED');
    if (outcome.status === 'CLAIMED') expect(outcome.job.lead.id).toBe(urgent.id);
  });

  it('renders the connection note server-side', async () => {
    const campaign = await createCampaignFixture({
      templateBody: 'Hi {{firstName}}, you work at {{company}} - worth connecting.',
    });
    const lead = await createLeadFixture({
      campaignId: campaign.id,
      firstName: 'Grace',
      company: 'Acme Clinical',
    });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('CLAIMED');
    if (outcome.status !== 'CLAIMED') return;

    expect(outcome.job.note).toBe('Hi Grace, you work at Acme Clinical - worth connecting.');
    expect(outcome.job.noteRenderError).toBeNull();
  });

  it('reports a note that cannot be rendered instead of sending a broken one', async () => {
    const campaign = await createCampaignFixture({
      templateBody: 'Hi {{firstName}}, ...',
      skipLeadsMissingTemplateVars: true,
    });
    const lead = await createLeadFixture({ campaignId: campaign.id, firstName: null });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id });
    expect(outcome.status).toBe('CLAIMED');
    if (outcome.status !== 'CLAIMED') return;

    expect(outcome.job.note).toBeNull();
    expect(outcome.job.noteRenderError).toContain('{{firstName}}');
  });

  it('writes a JOB_CLAIMED audit record', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    await claimNextJob({ workerId: worker.id });

    const log = await testDb().activityLog.findFirst({ where: { action: 'JOB_CLAIMED' } });
    expect(log?.workerId).toBe(worker.id);
    expect(log?.leadId).toBe(lead.id);
  });
});

describe('completeJob', () => {
  async function claimOne() {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();
    const outcome = await claimNextJob({ workerId: worker.id });
    if (outcome.status !== 'CLAIMED') throw new Error('expected a claim');
    return { campaign, lead, worker, job: outcome.job };
  }

  it('records SENT, marks the lead, and stamps invitationSentAt', async () => {
    const { lead, worker, job } = await claimOne();

    const result = await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'SENT',
    });

    expect(result.ok).toBe(true);

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(storedJob.status).toBe('COMPLETED');
    expect(storedJob.result).toBe('SENT');
    expect(storedJob.claimToken).toBeNull();

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('SENT');
    expect(storedLead.invitationSentAt).not.toBeNull();
  });

  it('records ALREADY_PENDING without stamping invitationSentAt', async () => {
    const { lead, worker, job } = await claimOne();

    await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'INVITATION_PENDING',
    });

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('ALREADY_PENDING');
    // Nothing was sent by us, so the send-guard timestamp must stay null.
    expect(storedLead.invitationSentAt).toBeNull();
  });

  it('records ALREADY_CONNECTED', async () => {
    const { lead, worker, job } = await claimOne();

    await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'ALREADY_CONNECTED',
    });

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('ALREADY_CONNECTED');
    expect(storedLead.invitationSentAt).toBeNull();
  });

  it('rejects a stale claim token', async () => {
    const { worker, job } = await claimOne();

    const result = await completeJob({
      jobId: job.jobId,
      claimToken: 'not-the-real-token-xxxxxxxx',
      workerId: worker.id,
      result: 'SENT',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CLAIM_MISMATCH');

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(storedJob.status).toBe('PROCESSING');
  });

  it('cannot complete the same job twice', async () => {
    const { worker, job } = await claimOne();

    const first = await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'SENT',
    });
    const second = await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'SENT',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('logs the outreach action so it counts against the daily limit', async () => {
    const { campaign, worker, job } = await claimOne();

    await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'SENT',
    });

    const log = await testDb().activityLog.findFirst({
      where: { action: 'CONNECT', result: 'SUCCESS', campaignId: campaign.id },
    });
    expect(log).not.toBeNull();
  });

  it('marks the campaign COMPLETED once nothing is left', async () => {
    const { campaign, worker, job } = await claimOne();

    const result = await completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      result: 'SENT',
    });

    expect(result.ok && result.campaignCompleted).toBe(true);
    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.active).toBe(false);
  });
});

describe('failJob', () => {
  async function claimOne(options: { maxAttempts?: number } = {}) {
    const campaign = await createCampaignFixture({
      maxAttemptsPerLead: options.maxAttempts ?? 3,
    });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      maxAttempts: options.maxAttempts ?? 3,
    });
    const worker = await createWorkerFixture();
    const outcome = await claimNextJob({ workerId: worker.id });
    if (outcome.status !== 'CLAIMED') throw new Error('expected a claim');
    return { campaign, lead, worker, job: outcome.job };
  }

  it('schedules a retry with backoff for a technical failure', async () => {
    const { lead, worker, job } = await claimOne();

    const result = await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'page load timeout',
      errorClass: 'TECHNICAL',
      pageState: 'NETWORK_ERROR',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe('RETRY_SCHEDULED');
    expect(result.nextAttemptAt).not.toBeNull();

    const stored = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(stored.status).toBe('WAITING');
    expect(stored.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    expect(stored.claimToken).toBeNull();

    // The lead must be claimable again for the retry.
    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('PENDING');
  });

  it('gives up once the attempt budget is exhausted', async () => {
    const { worker, job } = await claimOne({ maxAttempts: 1 });

    const result = await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'page load timeout',
      errorClass: 'TECHNICAL',
      pageState: 'NETWORK_ERROR',
    });

    expect(result.ok && result.disposition).toBe('EXHAUSTED');
    const stored = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(stored.status).toBe('FAILED');
  });

  it('does NOT retry a CAPTCHA - it escalates and latches the kill switch', async () => {
    const { lead, worker, job } = await claimOne();

    const result = await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'CAPTCHA detected',
      errorClass: 'SAFETY',
      pageState: 'CAPTCHA',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe('ESCALATED');
    expect(result.incidentId).not.toBeNull();
    expect(result.killSwitchEngaged).toBe(true);

    const stored = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(stored.status).toBe('REQUIRES_REVIEW');
    expect(stored.errorClass).toBe('SAFETY');

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('REQUIRES_REVIEW');

    const state = await testDb().systemState.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(state.killSwitchEngaged).toBe(true);
  });

  it('does NOT retry an account restriction, and blocks the lead', async () => {
    const { lead, worker, job } = await claimOne();

    await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'account restricted',
      errorClass: 'SAFETY',
      pageState: 'ACCOUNT_RESTRICTED',
    });

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('BLOCKED');

    const incident = await testDb().incident.findFirst({ where: { type: 'ACCOUNT_RESTRICTED' } });
    expect(incident?.blocksWorker).toBe(true);
    expect(incident?.severity).toBe('CRITICAL');
  });

  it('pauses the campaign when a blocking incident is opened against it', async () => {
    const { campaign, worker, job } = await claimOne();

    await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'security challenge',
      errorClass: 'SAFETY',
      pageState: 'SECURITY_CHALLENGE',
    });

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.active).toBe(false);
    expect(stored.status).toBe('PAUSED');
  });

  it('fails a permanent error without retrying and without an incident', async () => {
    const { lead, worker, job } = await claimOne();

    const result = await failJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      workerId: worker.id,
      error: 'profile does not exist',
      errorClass: 'PERMANENT',
      pageState: 'PROFILE_NOT_FOUND',
    });

    expect(result.ok && result.disposition).toBe('EXHAUSTED');
    expect(result.ok && result.incidentId).toBeNull();

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('SKIPPED');
  });

  it('rejects a stale claim token', async () => {
    const { worker, job } = await claimOne();

    const result = await failJob({
      jobId: job.jobId,
      claimToken: 'wrong-token-aaaaaaaaaa',
      workerId: worker.id,
      error: 'x',
      errorClass: 'TECHNICAL',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CLAIM_MISMATCH');
  });
});

describe('reapExpiredClaims - no job is lost to a crash', () => {
  it('requeues a job whose claim lease expired', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const outcome = await claimNextJob({ workerId: worker.id, leaseMs: -1_000 });
    expect(outcome.status).toBe('CLAIMED');

    const result = await reapExpiredClaims();

    expect(result.requeued).toBe(1);
    const jobs = await testDb().queueJob.findMany();
    expect(jobs[0]!.status).toBe('WAITING');
    expect(jobs[0]!.claimToken).toBeNull();
    // The attempt is not refunded, so a job that kills workers still terminates.
    expect(jobs[0]!.attempts).toBe(1);

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('PENDING');
  });

  it('leaves a healthy claim alone', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    await claimNextJob({ workerId: worker.id });
    const result = await reapExpiredClaims();

    expect(result.requeued).toBe(0);
    const jobs = await testDb().queueJob.findMany();
    expect(jobs[0]!.status).toBe('PROCESSING');
  });

  it('abandons a job that has no attempts left', async () => {
    const campaign = await createCampaignFixture({ maxAttemptsPerLead: 1 });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id, maxAttempts: 1 });
    const worker = await createWorkerFixture();

    await claimNextJob({ workerId: worker.id, leaseMs: -1_000 });
    await reapExpiredClaims();

    const jobs = await testDb().queueJob.findMany();
    expect(jobs[0]!.status).toBe('FAILED');
  });

  it('a requeued job can be claimed again', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    await claimNextJob({ workerId: worker.id, leaseMs: -1_000 });
    await reapExpiredClaims();

    const again = await claimNextJob({ workerId: worker.id });
    expect(again.status).toBe('CLAIMED');
    if (again.status === 'CLAIMED') expect(again.job.attempts).toBe(2);
  });
});

describe('getQueueCounts and eligibility reporting', () => {
  it('counts by status', async () => {
    const campaign = await createCampaignFixture();
    for (let i = 0; i < 3; i += 1) {
      const lead = await createLeadFixture({ campaignId: campaign.id });
      await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    }
    const doneLead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({
      leadId: doneLead.id,
      campaignId: campaign.id,
      status: 'COMPLETED',
    });

    const counts = await getQueueCounts();
    expect(counts.waiting).toBe(3);
    expect(counts.completed).toBe(1);
  });

  it('explains why an out-of-hours campaign is not eligible', async () => {
    // A one-minute window at 00:00 UTC, evaluated at midday.
    const campaign = await createCampaignFixture({
      timezone: 'UTC',
      windowStartMinute: 0,
      windowEndMinute: 1,
    });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    const result = await evaluateCampaignEligibility(new Date('2026-08-26T12:00:00Z'));

    expect(result).toHaveLength(1);
    expect(result[0]!.eligible).toBe(false);
    expect(result[0]!.reason).toBe('OUTSIDE_OPERATING_HOURS');
    expect(result[0]!.nextEligibleAt).not.toBeNull();
  });
});

describe('an unprocessable profile is marked for review, not silently failed', () => {
  it('sets both the lead and the job to REQUIRES_REVIEW', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const claim = await claimNextJob({ workerId: worker.id });
    if (claim.status !== 'CLAIMED') throw new Error('expected a claim');

    // What the worker reports for "loaded, but nothing I can act on".
    const result = await failJob({
      jobId: claim.job.jobId,
      claimToken: claim.job.claimToken,
      workerId: worker.id,
      error: 'Profile loaded but no connect action was available. Not guessing what to click.',
      errorClass: 'PERMANENT',
      pageState: 'PROFILE_FOUND',
    });

    expect(result.ok).toBe(true);

    const storedJob = await testDb().queueJob.findUniqueOrThrow({
      where: { id: claim.job.jobId },
    });
    expect(storedJob.status).toBe('REQUIRES_REVIEW');
    expect(storedJob.result).toBe('PROFILE_UNPROCESSABLE');

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('REQUIRES_REVIEW');
    // Nothing was sent, so the duplicate guard stays unarmed.
    expect(storedLead.invitationSentAt).toBeNull();
  });

  it('still marks a missing profile as SKIPPED rather than for review', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const claim = await claimNextJob({ workerId: worker.id });
    if (claim.status !== 'CLAIMED') throw new Error('expected a claim');

    await failJob({
      jobId: claim.job.jobId,
      claimToken: claim.job.claimToken,
      workerId: worker.id,
      error: 'profile does not exist',
      errorClass: 'PERMANENT',
      pageState: 'PROFILE_NOT_FOUND',
    });

    const storedJob = await testDb().queueJob.findUniqueOrThrow({
      where: { id: claim.job.jobId },
    });
    expect(storedJob.status).toBe('FAILED');

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('SKIPPED');
  });
});
