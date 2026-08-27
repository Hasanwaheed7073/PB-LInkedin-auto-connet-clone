import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaClient } from '@/lib/prisma-factory';
import { claimNextJob } from '@/lib/queue';

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

/**
 * Concurrent claiming.
 *
 * `FOR UPDATE ... SKIP LOCKED` can only be exercised meaningfully against a
 * PostgreSQL server that accepts several simultaneous connections. The local
 * development database (PGlite behind a socket server) serialises connections
 * onto one WASM instance, so the genuinely concurrent test cannot run there and
 * is skipped rather than passing vacuously.
 *
 * To run it, point TEST_CONCURRENT_DATABASE_URL at a real PostgreSQL - a
 * Supabase branch works - with the migrations already applied:
 *
 *   TEST_CONCURRENT_DATABASE_URL=postgresql://... npm run test:integration
 *
 * The sequential guarantees below DO run everywhere, because they are enforced by
 * partial unique indexes rather than by locking.
 */

const CONCURRENT_URL = process.env.TEST_CONCURRENT_DATABASE_URL;

/**
 * PGlite drops its connection - and does not recover it - whenever a query
 * errors, including an expected constraint violation. Tests that deliberately
 * provoke one therefore cannot run against the local development database.
 *
 * They are not left unverified: `npm run db:verify` probes exactly these partial
 * unique indexes on a single raw connection using savepoints, and is part of the
 * documented setup. These skip on PGlite and run against a real PostgreSQL.
 */
const pglite = await isPgliteBackend();

beforeAll(async () => {
  await assertDatabaseReady();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('duplicate prevention that holds without concurrency', () => {
  it.skipIf(pglite)('the database refuses a second live job for the same lead and action', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });

    // Enforced by the partial unique index, not by application code.
    await expect(createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id })).rejects.toThrow();

    expect(await testDb().queueJob.count()).toBe(1);
  });

  it.skipIf(pglite)('the database refuses a second COMPLETED job for the same lead and action', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'COMPLETED',
    });

    await expect(createQueueJobFixture({
        leadId: lead.id,
        campaignId: campaign.id,
        status: 'COMPLETED',
      })).rejects.toThrow();
  });

  it.skipIf(pglite)('a PROCESSING job blocks a new WAITING one for the same lead', async () => {
    const campaign = await createCampaignFixture();
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'PROCESSING',
    });

    await expect(createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id, status: 'WAITING' })).rejects.toThrow();
  });

  it('sequential claims never hand out the same job twice', async () => {
    const campaign = await createCampaignFixture();
    for (let i = 0; i < 5; i += 1) {
      const lead = await createLeadFixture({ campaignId: campaign.id });
      await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    }
    const worker = await createWorkerFixture();

    const claimed: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const outcome = await claimNextJob({ workerId: worker.id });
      if (outcome.status === 'CLAIMED') claimed.push(outcome.job.jobId);
    }

    expect(claimed).toHaveLength(5);
    expect(new Set(claimed).size).toBe(5);
  });

  it('a lead is never claimed twice even across many rounds', async () => {
    const campaign = await createCampaignFixture({ dailyLimit: 100 });
    const lead = await createLeadFixture({ campaignId: campaign.id });
    await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
    const worker = await createWorkerFixture();

    const leadIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await claimNextJob({ workerId: worker.id });
      if (outcome.status === 'CLAIMED') leadIds.push(outcome.job.lead.id);
    }

    expect(leadIds).toEqual([lead.id]);
  });
});

describe.skipIf(!CONCURRENT_URL)(
  'genuinely concurrent claiming (needs TEST_CONCURRENT_DATABASE_URL)',
  () => {
    it('two simultaneous claims never take the same job', async () => {
      const campaign = await createCampaignFixture();
      const lead = await createLeadFixture({ campaignId: campaign.id });
      await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
      const worker = await createWorkerFixture();

      // Two independent clients, so the two claims really are concurrent.
      const clientA = createPrismaClient({ connectionString: CONCURRENT_URL, poolMax: 5 });
      const clientB = createPrismaClient({ connectionString: CONCURRENT_URL, poolMax: 5 });

      try {
        const [a, b] = await Promise.all([
          claimNextJob({ workerId: worker.id }),
          claimNextJob({ workerId: worker.id }),
        ]);

        const claims = [a, b].filter((r) => r.status === 'CLAIMED');
        // Exactly one wins; SKIP LOCKED makes the loser see nothing.
        expect(claims).toHaveLength(1);
      } finally {
        await clientA.$disconnect();
        await clientB.$disconnect();
      }
    });

    it('ten simultaneous claims over ten jobs hand out ten distinct jobs', async () => {
      const campaign = await createCampaignFixture({ dailyLimit: 100 });
      for (let i = 0; i < 10; i += 1) {
        const lead = await createLeadFixture({ campaignId: campaign.id });
        await createQueueJobFixture({ leadId: lead.id, campaignId: campaign.id });
      }
      const worker = await createWorkerFixture();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => claimNextJob({ workerId: worker.id })),
      );

      const jobIds = results
        .filter((r) => r.status === 'CLAIMED')
        .map((r) => (r.status === 'CLAIMED' ? r.job.jobId : ''));

      expect(new Set(jobIds).size).toBe(jobIds.length);
    });
  },
);
