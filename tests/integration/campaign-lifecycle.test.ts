import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { engageEmergencyStop } from '@/lib/safety';

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
 * Campaign activation, pause and resume, exercised through the server actions.
 *
 * The server actions require an authenticated operator and call `revalidatePath`,
 * neither of which exists outside a request. Both are stubbed so the actual
 * campaign-state logic - which is what these tests are about - runs for real
 * against the database.
 */

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    requireUser: async () => ({
      id: 'test-operator-id',
      email: 'operator@example.com',
      name: 'Test Operator',
      role: 'OPERATOR',
    }),
  };
});

const { activateCampaign, pauseCampaign, resumeCampaign, getActivationChecks, createCampaign } =
  await import('@/server/actions/campaigns');

beforeAll(async () => {
  await assertDatabaseReady();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await resetDatabase();
});

const VALID_SETTINGS = {
  timezone: 'UTC',
  dailyLimit: 10,
  windowStartMinute: 0,
  windowEndMinute: 1439,
  operatingDays: [1, 2, 3, 4, 5, 6, 7],
  minActionDelaySeconds: 45,
  maxActionDelaySeconds: 90,
  maxAttemptsPerLead: 3,
  pauseOnIncident: true,
  skipLeadsMissingTemplateVars: true,
};

describe('createCampaign', () => {
  it('always creates a DRAFT that is not active', async () => {
    const result = await createCampaign({
      name: 'Q3 outreach',
      description: null,
      messageTemplateId: null,
      settings: VALID_SETTINGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const campaign = await testDb().campaign.findUniqueOrThrow({
      where: { id: result.data.id },
    });
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.active).toBe(false);
  });

  it('rejects a duplicate name', async () => {
    await createCampaign({
      name: 'Same name',
      description: null,
      messageTemplateId: null,
      settings: VALID_SETTINGS,
    });
    const second = await createCampaign({
      name: 'Same name',
      description: null,
      messageTemplateId: null,
      settings: VALID_SETTINGS,
    });

    expect(second.ok).toBe(false);
  });

  it('rejects settings with no operating days', async () => {
    const result = await createCampaign({
      name: 'Never runs',
      description: null,
      messageTemplateId: null,
      settings: { ...VALID_SETTINGS, operatingDays: [] },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a max delay lower than the min delay', async () => {
    const result = await createCampaign({
      name: 'Bad delays',
      description: null,
      messageTemplateId: null,
      settings: { ...VALID_SETTINGS, minActionDelaySeconds: 300, maxActionDelaySeconds: 60 },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognised timezone', async () => {
    const result = await createCampaign({
      name: 'Bad zone',
      description: null,
      messageTemplateId: null,
      settings: { ...VALID_SETTINGS, timezone: 'Mars/Olympus' },
    });

    expect(result.ok).toBe(false);
  });
});

describe('activateCampaign', () => {
  it('requires explicit confirmation', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });
    await createLeadFixture({ campaignId: campaign.id });

    // confirm: false must be rejected by the schema.
    const result = await activateCampaign({ id: campaign.id, confirm: false });
    expect(result.ok).toBe(false);

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.active).toBe(false);
  });

  it('activates and queues when the checks pass', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });
    for (let i = 0; i < 3; i += 1) await createLeadFixture({ campaignId: campaign.id });

    const result = await activateCampaign({ id: campaign.id, confirm: true, generateQueue: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.queued).toBe(3);

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.active).toBe(true);
    expect(stored.activatedBy).toBe('Test Operator');
  });

  it('refuses to activate with no pending leads', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });

    const result = await activateCampaign({ id: campaign.id, confirm: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Leads to work');
  });

  it('refuses to activate while the emergency stop is engaged', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });
    await createLeadFixture({ campaignId: campaign.id });
    await engageEmergencyStop({ reason: 'test' });

    const result = await activateCampaign({ id: campaign.id, confirm: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Emergency stop');
  });

  it('refuses to activate while a blocking incident is open', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });
    await createLeadFixture({ campaignId: campaign.id });
    await testDb().incident.create({
      data: {
        type: 'CAPTCHA',
        severity: 'CRITICAL',
        title: 'CAPTCHA',
        description: 'x',
        blocksWorker: true,
      },
    });

    const result = await activateCampaign({ id: campaign.id, confirm: true });
    expect(result.ok).toBe(false);
  });

  it('refuses to reactivate a COMPLETED campaign', async () => {
    const campaign = await createCampaignFixture({ status: 'COMPLETED', active: false });
    await createLeadFixture({ campaignId: campaign.id });

    const result = await activateCampaign({ id: campaign.id, confirm: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('COMPLETED');
  });

  it('records the activation in the audit log', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });
    await createLeadFixture({ campaignId: campaign.id });

    await activateCampaign({ id: campaign.id, confirm: true });

    const log = await testDb().activityLog.findFirst({
      where: { action: 'CAMPAIGN_ACTIVATED' },
    });
    expect(log?.actorName).toBe('Test Operator');
  });
});

describe('getActivationChecks', () => {
  it('reports every blocking condition', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });

    const checks = await getActivationChecks(campaign.id);
    const byLabel = new Map(checks.map((c) => [c.label, c]));

    expect(byLabel.get('Emergency stop')?.ok).toBe(true);
    expect(byLabel.get('Leads to work')?.ok).toBe(false);
    expect(byLabel.get('Schedule configured')?.ok).toBe(true);
  });

  it('flags a template that will not render for some leads, without blocking', async () => {
    const campaign = await createCampaignFixture({
      status: 'DRAFT',
      active: false,
      templateBody: 'Hi {{firstName}}, worth connecting.',
    });
    await createLeadFixture({ campaignId: campaign.id, firstName: 'Grace' });
    await createLeadFixture({ campaignId: campaign.id, firstName: null });

    const checks = await getActivationChecks(campaign.id);
    const template = checks.find((c) => c.label === 'Message template renders');

    expect(template?.ok).toBe(false);
    // Advisory, not blocking: those leads are skipped, not sent a broken note.
    expect(template?.blocking).toBe(false);
    expect(template?.detail).toContain('1 of 2');
  });
});

describe('pauseCampaign and resumeCampaign', () => {
  it('pausing stops new work but keeps the queue', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    const result = await pauseCampaign({ id: campaign.id, reason: 'Reviewing the list' });
    expect(result.ok).toBe(true);

    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('PAUSED');
    expect(stored.active).toBe(false);
    expect(stored.pauseReason).toBe('Reviewing the list');

    // The plan is preserved so resuming continues where it left off.
    const jobs = await testDb().queueJob.findMany();
    expect(jobs[0]!.status).toBe('WAITING');
  });

  it('resuming restores RUNNING and keeps the same queue', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    const job = await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    await pauseCampaign({ id: campaign.id });
    const result = await resumeCampaign({ id: campaign.id });

    expect(result.ok).toBe(true);
    const stored = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.active).toBe(true);
    expect(stored.pauseReason).toBeNull();

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(storedJob.status).toBe('WAITING');
  });

  it('refuses to resume while a blocking incident is open', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    await createLeadFixture({ campaignId: campaign.id });
    await pauseCampaign({ id: campaign.id });

    await testDb().incident.create({
      data: {
        type: 'SECURITY_CHALLENGE',
        severity: 'CRITICAL',
        title: 'Challenge',
        description: 'x',
        blocksWorker: true,
      },
    });

    const result = await resumeCampaign({ id: campaign.id });
    expect(result.ok).toBe(false);
  });

  it('refuses to resume a campaign that is not paused', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    const result = await resumeCampaign({ id: campaign.id });
    expect(result.ok).toBe(false);
  });

  it('refuses to pause an already paused campaign', async () => {
    const campaign = await createCampaignFixture({ active: false, status: 'PAUSED' });
    const result = await pauseCampaign({ id: campaign.id });
    expect(result.ok).toBe(false);
  });

  it('records pause and resume in the audit log', async () => {
    const campaign = await createCampaignFixture({ active: true, status: 'RUNNING' });
    await createLeadFixture({ campaignId: campaign.id });

    await pauseCampaign({ id: campaign.id, reason: 'lunch' });
    await resumeCampaign({ id: campaign.id });

    const actions = await testDb().activityLog.findMany({
      where: { action: { in: ['CAMPAIGN_PAUSED', 'CAMPAIGN_RESUMED'] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(['CAMPAIGN_PAUSED', 'CAMPAIGN_RESUMED']);
  });
});
