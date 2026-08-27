import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertDatabaseReady,
  createCampaignFixture,
  createLeadFixture,
  disconnectTestDb,
  resetDatabase,
  testDb,
} from '../helpers/db';

/**
 * CSV import against the real database.
 *
 * The properties that matter: the preview tells the truth, the confirm step
 * writes exactly what was previewed, and an import can never resurrect or
 * overwrite a lead that has already been contacted.
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

const { previewLeadImport, confirmLeadImport, setLeadStatus, deleteLead } = await import(
  '@/server/actions/leads'
);

beforeAll(async () => {
  await assertDatabaseReady();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await resetDatabase();
});

const CSV = [
  'firstName,lastName,linkedinUrl,company,jobTitle,location',
  'John,Smith,https://www.linkedin.com/in/john-smith,Acme Clinical,CRA,Berlin',
  'Sarah,Jones,https://www.linkedin.com/in/sarah-jones,Globex,CRC II,London',
  'Michael,Brown,https://www.linkedin.com/in/michael-brown,Initech,CTM,Dublin',
].join('\n');

describe('previewLeadImport', () => {
  it('reports what would be imported without writing anything', async () => {
    const result = await previewLeadImport({ csv: CSV });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary.willImport).toBe(3);
    expect(result.data.summary.alreadyInDatabase).toBe(0);

    // Nothing was written.
    expect(await testDb().lead.count()).toBe(0);
  });

  it('detects leads that already exist', async () => {
    await createLeadFixture({ slug: 'john-smith', status: 'SENT' });

    const result = await previewLeadImport({ csv: CSV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.summary.willImport).toBe(2);
    expect(result.data.summary.alreadyInDatabase).toBe(1);
    expect(result.data.alreadyInDatabase[0]?.existingStatus).toBe('SENT');
  });

  it('reports the detected column mapping', async () => {
    const result = await previewLeadImport({ csv: CSV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.detectedColumns).toMatchObject({
      firstName: 'firstName',
      linkedinUrl: 'linkedinUrl',
      company: 'company',
    });
  });

  it('errors clearly when there is no URL column', async () => {
    const result = await previewLeadImport({ csv: 'name,company\nJohn Smith,Acme' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('LinkedIn URL column');
  });
});

describe('confirmLeadImport', () => {
  it('writes exactly the previewed rows', async () => {
    const result = await confirmLeadImport({ csv: CSV, expectedCount: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(3);

    const leads = await testDb().lead.findMany({ orderBy: { createdAt: 'asc' } });
    expect(leads).toHaveLength(3);
    expect(leads[0]).toMatchObject({
      firstName: 'John',
      lastName: 'Smith',
      linkedinUrl: 'https://www.linkedin.com/in/john-smith',
      company: 'Acme Clinical',
      status: 'PENDING',
    });
    // Every imported lead shares an import batch id, for auditing.
    expect(new Set(leads.map((l) => l.importBatchId)).size).toBe(1);
  });

  it('REFUSES the import if the count changed since the preview', async () => {
    // The operator saw 3, but someone imported one of them meanwhile.
    await createLeadFixture({ slug: 'john-smith' });

    const result = await confirmLeadImport({ csv: CSV, expectedCount: 3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('changed since the preview');

    // Nothing beyond the pre-existing lead was written.
    expect(await testDb().lead.count()).toBe(1);
  });

  it('never overwrites an existing lead', async () => {
    const existing = await createLeadFixture({
      slug: 'john-smith',
      status: 'SENT',
      firstName: 'Johnathan',
      company: 'Old Company',
    });
    await testDb().lead.update({
      where: { id: existing.id },
      data: { invitationSentAt: new Date() },
    });

    const result = await confirmLeadImport({ csv: CSV, expectedCount: 2 });
    expect(result.ok).toBe(true);

    const stored = await testDb().lead.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.status).toBe('SENT');
    expect(stored.firstName).toBe('Johnathan');
    expect(stored.company).toBe('Old Company');
    expect(stored.invitationSentAt).not.toBeNull();
  });

  it('assigns to a campaign when asked', async () => {
    const campaign = await createCampaignFixture({ status: 'DRAFT', active: false });

    const result = await confirmLeadImport({
      csv: CSV,
      expectedCount: 3,
      campaignId: campaign.id,
    });

    expect(result.ok).toBe(true);
    const leads = await testDb().lead.findMany();
    expect(leads.every((l) => l.campaignId === campaign.id)).toBe(true);
  });

  it('rejects a non-existent campaign', async () => {
    const result = await confirmLeadImport({
      csv: CSV,
      expectedCount: 3,
      campaignId: 'cxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(result.ok).toBe(false);
  });

  it('records the import in the audit log', async () => {
    await confirmLeadImport({ csv: CSV, expectedCount: 3, fileName: 'leads.csv' });

    const log = await testDb().activityLog.findFirst({ where: { action: 'LEADS_IMPORTED' } });
    expect(log?.actorName).toBe('Test Operator');
    expect(log?.message).toContain('leads.csv');
    expect(log?.metadata).toMatchObject({ created: 3 });
  });

  it('normalises URLs so variants collapse to one lead', async () => {
    const messy = [
      'fullName,linkedinUrl',
      'John Smith,https://www.linkedin.com/in/john-smith/',
      'J Smith,http://linkedin.com/in/JOHN-SMITH?trk=x',
      'Johnny,https://de.linkedin.com/in/john-smith',
    ].join('\n');

    const preview = await previewLeadImport({ csv: messy });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.summary.willImport).toBe(1);
    expect(preview.data.summary.duplicateInFile).toBe(2);

    await confirmLeadImport({ csv: messy, expectedCount: 1 });
    const leads = await testDb().lead.findMany();
    expect(leads).toHaveLength(1);
    expect(leads[0]!.linkedinUrl).toBe('https://www.linkedin.com/in/john-smith');
  });

  it('handles a 600-lead import', async () => {
    const rows = Array.from(
      { length: 600 },
      (_, i) => `Person ${i},https://www.linkedin.com/in/bulk-person-${i},Acme,CRA`,
    );
    const csv = ['fullName,linkedinUrl,company,jobTitle', ...rows].join('\n');

    const result = await confirmLeadImport({ csv, expectedCount: 600 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(600);
    expect(await testDb().lead.count()).toBe(600);
  });
});

describe('setLeadStatus', () => {
  it('refuses to set SENT by hand', async () => {
    const lead = await createLeadFixture({});
    const result = await setLeadStatus({ id: lead.id, status: 'SENT' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cannot be set by hand');
  });

  it('refuses to set PROCESSING by hand', async () => {
    const lead = await createLeadFixture({});
    const result = await setLeadStatus({ id: lead.id, status: 'PROCESSING' });
    expect(result.ok).toBe(false);
  });

  it('allows SKIPPED and cancels queued work', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    const job = await testDb().queueJob.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        action: 'CONNECT',
        status: 'WAITING',
        scheduledFor: new Date(),
      },
    });

    const result = await setLeadStatus({ id: lead.id, status: 'SKIPPED', reason: 'wrong person' });
    expect(result.ok).toBe(true);

    const storedLead = await testDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(storedLead.status).toBe('SKIPPED');

    const storedJob = await testDb().queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(storedJob.status).toBe('CANCELLED');
  });

  it('refuses to change a lead the worker is processing', async () => {
    const lead = await createLeadFixture({ status: 'PROCESSING' });
    const result = await setLeadStatus({ id: lead.id, status: 'SKIPPED' });
    expect(result.ok).toBe(false);
  });
});

describe('deleteLead', () => {
  it('refuses to delete a lead that has been sent an invitation', async () => {
    const lead = await createLeadFixture({ status: 'SENT' });
    await testDb().lead.update({
      where: { id: lead.id },
      data: { invitationSentAt: new Date() },
    });

    const result = await deleteLead(lead.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already been sent');
    // The row that prevents re-contacting them is still there.
    expect(await testDb().lead.count({ where: { id: lead.id } })).toBe(1);
  });

  it('deletes an uncontacted lead and logs it first', async () => {
    const lead = await createLeadFixture({ status: 'PENDING' });

    const result = await deleteLead(lead.id);
    expect(result.ok).toBe(true);

    expect(await testDb().lead.count({ where: { id: lead.id } })).toBe(0);
    const log = await testDb().activityLog.findFirst({ where: { action: 'LEAD_DELETED' } });
    expect(log).not.toBeNull();
  });

  it('refuses to delete a lead being processed', async () => {
    const lead = await createLeadFixture({ status: 'PROCESSING' });
    const result = await deleteLead(lead.id);
    expect(result.ok).toBe(false);
  });
});
