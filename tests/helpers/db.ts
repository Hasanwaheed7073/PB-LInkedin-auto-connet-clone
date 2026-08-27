import type { PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db';

/**
 * Integration-test database helpers.
 *
 * Tests run against the real PostgreSQL started by `npm run db:local`, because
 * the guarantees being tested (partial unique indexes, `FOR UPDATE SKIP
 * LOCKED`, the append-only trigger) only exist in a real Postgres.
 *
 * `TRUNCATE` is used rather than `DELETE` for two reasons: it is far faster, and
 * `activity_logs` has a BEFORE DELETE trigger that rejects row deletion.
 * TRUNCATE fires statement-level triggers only, so it is the one way to clear
 * the audit table in tests without disabling the protection being tested.
 */

/**
 * Tests share the application's own Prisma client rather than creating their
 * own.
 *
 * This is not just tidiness: a second client means a second connection pool,
 * and the local PGlite socket server accepts one connection at a time. Two
 * pools produce "Server has closed the connection" on whichever loses the race.
 * Reusing the app client also means tests exercise exactly the configuration the
 * app runs with.
 */
export function testDb(): PrismaClient {
  return prisma;
}

export async function disconnectTestDb(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * The operator id the server-action tests mock `requireUser` to return. It must
 * match a real `users` row, because `campaigns.createdById` is a foreign key.
 */
export const TEST_OPERATOR_ID = 'test-operator-id';

const TABLES = [
  'activity_logs',
  'incidents',
  'queue_jobs',
  'leads',
  'campaign_settings',
  'campaigns',
  'message_templates',
  'workers',
  'system_state',
  'users',
];

/**
 * Wipe every table and reset the SystemState singleton to "nothing is stopped".
 *
 * Retries once after forcing a reconnect. PGlite drops its single connection
 * whenever any query errors, and vitest gives each test file its own module
 * registry (so its own pool), which means a file can inherit a dead connection
 * from the one before it. The retry makes the suite robust against that rather
 * than failing on unrelated bookkeeping.
 */
export async function resetDatabase(): Promise<void> {
  const truncate = `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const db = testDb();
      await db.$executeRawUnsafe(truncate);
      await db.systemState.create({ data: { id: 'singleton' } });
      // The operator row the server-action tests act as. `campaigns.createdById`
      // is a real foreign key, so without this row every createCampaign fails.
      await db.user.create({
        data: {
          id: TEST_OPERATOR_ID,
          email: 'operator@example.com',
          name: 'Test Operator',
          passwordHash: 'scrypt$dGVzdA==$dGVzdA==',
        },
      });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await prisma.$disconnect().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Is the target database PGlite (the local WASM PostgreSQL) rather than a real
 * server?
 *
 * Two limitations follow from PGlite that tests need to know about:
 *  - it accepts a single connection, so nothing can open a second client; and
 *  - a trigger that raises an exception outside a savepoint resets the whole
 *    instance.
 *
 * Tests that genuinely need either capability skip themselves rather than
 * passing vacuously, and say why.
 */
export async function isPgliteBackend(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ version: string }[]>('SELECT version()');
  return /pglite/i.test(rows[0]?.version ?? '');
}

/**
 * Assert that a database operation is rejected, and leave the connection usable.
 *
 * PGlite drops its single connection whenever a query errors - including an
 * expected constraint violation - so a test that provokes one would break every
 * query after it. Disconnecting forces the pool to establish a fresh connection
 * on the next query.
 *
 * Harmless against a real PostgreSQL, where the connection would have survived
 * anyway.
 */
export async function expectDbRejection(fn: () => Promise<unknown>): Promise<boolean> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  await prisma.$disconnect().catch(() => undefined);
  return rejected;
}

/** Confirm the database is reachable and migrated, with a clear message if not. */
export async function assertDatabaseReady(): Promise<void> {
  const db = testDb();
  try {
    await db.$queryRawUnsafe('SELECT 1');
  } catch (error) {
    throw new Error(
      'Cannot reach the test database. Start it with `npm run db:local` in another terminal, ' +
        'then `npm run db:deploy`.\n' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'queue_jobs'`,
  );
  if (Number(rows[0]?.count ?? 0) === 0) {
    throw new Error('The test database has no schema. Run `npm run db:deploy`.');
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface CampaignFixtureOptions {
  name?: string;
  active?: boolean;
  status?: 'DRAFT' | 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ERROR';
  dailyLimit?: number;
  timezone?: string;
  /** Defaults to a window that is always open, so tests do not fight the clock. */
  windowStartMinute?: number;
  windowEndMinute?: number;
  operatingDays?: number[];
  minActionDelaySeconds?: number;
  maxActionDelaySeconds?: number;
  maxAttemptsPerLead?: number;
  pauseOnIncident?: boolean;
  skipLeadsMissingTemplateVars?: boolean;
  templateBody?: string | null;
}

/**
 * A campaign that is genuinely runnable.
 *
 * Defaults to a 00:00-23:59 window on all seven days so scheduling never
 * accidentally becomes the reason a test fails. Tests that care about operating
 * hours set them explicitly.
 */
export async function createCampaignFixture(options: CampaignFixtureOptions = {}) {
  const db = testDb();

  const template = options.templateBody
    ? await db.messageTemplate.create({
        data: {
          name: `template-${Math.random().toString(36).slice(2, 10)}`,
          body: options.templateBody,
        },
      })
    : null;

  return db.campaign.create({
    data: {
      name: options.name ?? `campaign-${Math.random().toString(36).slice(2, 10)}`,
      status: options.status ?? 'RUNNING',
      active: options.active ?? true,
      messageTemplateId: template?.id ?? null,
      settings: {
        create: {
          timezone: options.timezone ?? 'UTC',
          dailyLimit: options.dailyLimit ?? 20,
          windowStartMinute: options.windowStartMinute ?? 0,
          windowEndMinute: options.windowEndMinute ?? 1439,
          operatingDays: options.operatingDays ?? [1, 2, 3, 4, 5, 6, 7],
          minActionDelaySeconds: options.minActionDelaySeconds ?? 45,
          maxActionDelaySeconds: options.maxActionDelaySeconds ?? 60,
          maxAttemptsPerLead: options.maxAttemptsPerLead ?? 3,
          pauseOnIncident: options.pauseOnIncident ?? true,
          skipLeadsMissingTemplateVars: options.skipLeadsMissingTemplateVars ?? true,
        },
      },
    },
    include: { settings: true, messageTemplate: true },
  });
}

export interface LeadFixtureOptions {
  slug?: string;
  campaignId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  status?:
    | 'PENDING'
    | 'PROCESSING'
    | 'SENT'
    | 'ALREADY_CONNECTED'
    | 'ALREADY_PENDING'
    | 'SKIPPED'
    | 'FAILED'
    | 'REQUIRES_REVIEW'
    | 'BLOCKED';
  invitationSentAt?: Date | null;
}

let leadCounter = 0;

export async function createLeadFixture(options: LeadFixtureOptions = {}) {
  const db = testDb();
  leadCounter += 1;
  const slug = options.slug ?? `test-lead-${leadCounter}-${Math.random().toString(36).slice(2, 8)}`;

  return db.lead.create({
    data: {
      fullName: `${options.firstName ?? 'Test'} ${options.lastName ?? `Lead${leadCounter}`}`,
      firstName: options.firstName === undefined ? 'Test' : options.firstName,
      lastName: options.lastName === undefined ? `Lead${leadCounter}` : options.lastName,
      linkedinUrl: `https://www.linkedin.com/in/${slug}`,
      publicIdentifier: slug,
      company: options.company === undefined ? 'Acme Clinical' : options.company,
      jobTitle: options.jobTitle === undefined ? 'Clinical Research Associate' : options.jobTitle,
      campaignId: options.campaignId ?? null,
      status: options.status ?? 'PENDING',
      invitationSentAt: options.invitationSentAt ?? null,
    },
  });
}

export async function createWorkerFixture(name = 'test-worker') {
  const db = testDb();
  const worker = await db.worker.create({
    data: { name, hostname: 'test-host', pid: process.pid, status: 'IDLE' },
  });
  await db.systemState.update({
    where: { id: 'singleton' },
    data: { activeWorkerId: worker.id },
  });
  return worker;
}

/** Queue a job directly, bypassing scheduling, for tests about claiming. */
export async function createQueueJobFixture(options: {
  leadId: string;
  campaignId: string;
  scheduledFor?: Date;
  status?: 'WAITING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REQUIRES_REVIEW';
  attempts?: number;
  maxAttempts?: number;
  priority?: number;
}) {
  const db = testDb();
  return db.queueJob.create({
    data: {
      leadId: options.leadId,
      campaignId: options.campaignId,
      action: 'CONNECT',
      status: options.status ?? 'WAITING',
      scheduledFor: options.scheduledFor ?? new Date(Date.now() - 1_000),
      attempts: options.attempts ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      priority: options.priority ?? 100,
    },
  });
}
