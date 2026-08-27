/**
 * Database state verification.
 *
 * Proves the safety guarantees actually exist in the running database rather
 * than only in the migration file. Run after `npm run db:deploy`.
 *
 *   npm run db:verify
 *
 * Every "this should be rejected" probe runs inside a SAVEPOINT, because a
 * constraint violation aborts the enclosing transaction in PostgreSQL and every
 * later statement would fail for the wrong reason.
 */

import 'dotenv/config';

import { Client } from 'pg';

const EXPECTED_TABLES = [
  'users',
  'campaigns',
  'campaign_settings',
  'message_templates',
  'leads',
  'queue_jobs',
  'workers',
  'activity_logs',
  'incidents',
  'system_state',
];

const EXPECTED_INDEXES = [
  'queue_jobs_one_live_per_lead_action',
  'queue_jobs_one_completed_per_lead_action',
  'leads_linkedin_url_lower_unique',
  'queue_jobs_claimable_idx',
  'queue_jobs_expired_claims_idx',
  'activity_logs_outreach_counting_idx',
  'incidents_blocking_open_idx',
];

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}\n`);
}

/**
 * Run a statement expected to be rejected, inside a savepoint so the outer
 * transaction stays usable. Returns true when it was indeed rejected.
 */
async function expectRejected(client: Client, name: string, sql: string): Promise<boolean> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await client.query(sql);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return false;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return true;
  }
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const version = await client.query<{ version: string }>('SELECT version()');
    process.stdout.write(`\n${version.rows[0]?.version}\n\n`);

    // --- Tables ----------------------------------------------------------
    process.stdout.write('Tables\n');
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tableNames = new Set(tables.rows.map((r) => r.table_name));
    for (const table of EXPECTED_TABLES) check(table, tableNames.has(table));

    // --- Indexes ---------------------------------------------------------
    process.stdout.write('\nSafety indexes\n');
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    for (const index of EXPECTED_INDEXES) {
      check(index, byName.has(index), byName.has(index) ? '' : 'missing');
    }

    // --- Duplicate protection -------------------------------------------
    process.stdout.write('\nDuplicate protection is enforced by the database\n');

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "campaigns" ("id","name","status","active","createdAt","updatedAt")
       VALUES ('vfy_camp','__verify__','DRAFT',false,now(),now())`,
    );
    await client.query(
      `INSERT INTO "leads" ("id","fullName","linkedinUrl","publicIdentifier","status","attempts","createdAt","updatedAt")
       VALUES ('vfy_lead','Verify Person','https://www.linkedin.com/in/__verify__','__verify__','PENDING',0,now(),now())`,
    );
    await client.query(
      `INSERT INTO "queue_jobs" ("id","leadId","campaignId","action","status","priority","scheduledFor","attempts","maxAttempts","errorClass","createdAt","updatedAt")
       VALUES ('vfy_job1','vfy_lead','vfy_camp','CONNECT','WAITING',100,now(),0,3,'NONE',now(),now())`,
    );

    check(
      'a second live CONNECT job for the same lead is rejected',
      await expectRejected(
        client,
        sp1,
        `INSERT INTO "queue_jobs" ("id","leadId","campaignId","action","status","priority","scheduledFor","attempts","maxAttempts","errorClass","createdAt","updatedAt")
         VALUES ('vfy_job2','vfy_lead','vfy_camp','CONNECT','WAITING',100,now(),0,3,'NONE',now(),now())`,
      ),
    );

    check(
      'the same profile URL cannot be inserted twice (case-insensitive)',
      await expectRejected(
        client,
        sp2,
        `INSERT INTO "leads" ("id","fullName","linkedinUrl","publicIdentifier","status","attempts","createdAt","updatedAt")
         VALUES ('vfy_lead2','Verify Again','https://www.linkedin.com/in/__VERIFY__','__verify__','PENDING',0,now(),now())`,
      ),
    );

    // A PROCESSING job also counts as live, so the guard must still hold.
    await client.query(`UPDATE "queue_jobs" SET "status" = 'PROCESSING' WHERE "id" = 'vfy_job1'`);
    check(
      'a WAITING job cannot be added while one is already PROCESSING for that lead',
      await expectRejected(
        client,
        sp3,
        `INSERT INTO "queue_jobs" ("id","leadId","campaignId","action","status","priority","scheduledFor","attempts","maxAttempts","errorClass","createdAt","updatedAt")
         VALUES ('vfy_job4','vfy_lead','vfy_camp','CONNECT','WAITING',100,now(),0,3,'NONE',now(),now())`,
      ),
    );

    await client.query(`UPDATE "queue_jobs" SET "status" = 'COMPLETED' WHERE "id" = 'vfy_job1'`);
    check(
      'a lead+action can never have two COMPLETED jobs (no duplicate invitation)',
      await expectRejected(
        client,
        sp4,
        `INSERT INTO "queue_jobs" ("id","leadId","campaignId","action","status","priority","scheduledFor","attempts","maxAttempts","errorClass","createdAt","updatedAt")
         VALUES ('vfy_job3','vfy_lead','vfy_camp','CONNECT','COMPLETED',100,now(),1,3,'NONE',now(),now())`,
      ),
    );

    // A different action for the same lead is legitimate and must be allowed.
    let differentActionAllowed = true;
    try {
      await client.query(`SAVEPOINT ${sp5}`);
      await client.query(
        `INSERT INTO "queue_jobs" ("id","leadId","campaignId","action","status","priority","scheduledFor","attempts","maxAttempts","errorClass","createdAt","updatedAt")
         VALUES ('vfy_job5','vfy_lead','vfy_camp','PROFILE_VISIT','WAITING',100,now(),0,3,'NONE',now(),now())`,
      );
      await client.query(`RELEASE SAVEPOINT ${sp5}`);
    } catch {
      differentActionAllowed = false;
      await client.query(`ROLLBACK TO SAVEPOINT ${sp5}`);
    }
    check('a different action for the same lead is still allowed', differentActionAllowed);

    await client.query('ROLLBACK');

    // --- Append-only activity log ---------------------------------------
    process.stdout.write('\nImmutable activity log\n');
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "activity_logs" ("id","createdAt","action","result","actorType")
       VALUES ('vfy_log','now()','CONNECT','SUCCESS','SYSTEM')`,
    );
    check(
      'UPDATE on activity_logs is rejected by a trigger',
      await expectRejected(
        client,
        sp6,
        `UPDATE "activity_logs" SET "result" = 'FAILED' WHERE "id" = 'vfy_log'`,
      ),
    );
    check(
      'DELETE on activity_logs is rejected by a trigger',
      await expectRejected(client, sp7, `DELETE FROM "activity_logs" WHERE "id" = 'vfy_log'`),
    );
    await client.query('ROLLBACK');

    // --- SKIP LOCKED support --------------------------------------------
    process.stdout.write('\nRow-locking support\n');
    let skipLockedWorks = false;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT "id" FROM "queue_jobs" WHERE "status" = 'WAITING'
         ORDER BY "priority" FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      await client.query('COMMIT');
      skipLockedWorks = true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      process.stdout.write(`      ${error instanceof Error ? error.message : String(error)}\n`);
    }
    check('FOR UPDATE ... SKIP LOCKED is supported', skipLockedWorks);

    // The exact CTE the claim path uses must parse and run.
    let claimCteWorks = false;
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH candidate AS (
           SELECT j."id"
           FROM "queue_jobs" j
           JOIN "campaigns" c ON c."id" = j."campaignId"
           JOIN "leads" l ON l."id" = j."leadId"
           WHERE j."status" = 'WAITING'
             AND j."scheduledFor" <= now()
             AND c."active" = TRUE
             AND c."status" = 'RUNNING'
             AND l."invitationSentAt" IS NULL
             AND l."status" IN ('PENDING', 'FAILED')
             AND NOT EXISTS (
               SELECT 1 FROM "queue_jobs" q2
               WHERE q2."leadId" = j."leadId" AND q2."action" = j."action"
                 AND q2."id" <> j."id" AND q2."status" IN ('COMPLETED','PROCESSING')
             )
           ORDER BY j."priority" ASC, j."scheduledFor" ASC, j."createdAt" ASC
           FOR UPDATE OF j SKIP LOCKED
           LIMIT 1
         )
         UPDATE "queue_jobs" AS t
         SET "status" = 'PROCESSING'
         FROM candidate
         WHERE t."id" = candidate."id"
         RETURNING t."id"`,
      );
      await client.query('ROLLBACK');
      claimCteWorks = true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      process.stdout.write(`      ${error instanceof Error ? error.message : String(error)}\n`);
    }
    check('the job-claiming CTE runs against the real schema', claimCteWorks);

    // --- Check constraints ----------------------------------------------
    process.stdout.write('\nConfiguration sanity constraints\n');
    const constraints = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c'`,
    );
    const conNames = new Set(constraints.rows.map((r) => r.conname));
    for (const name of [
      'system_state_singleton',
      'campaign_settings_sane_window',
      'campaign_settings_sane_delays',
      'campaign_settings_sane_daily_limit',
      'queue_jobs_sane_attempts',
    ]) {
      check(name, conNames.has(name));
    }

    process.stdout.write(
      failures === 0
        ? '\nAll database guarantees verified.\n\n'
        : `\n${failures} check(s) FAILED.\n\n`,
    );
  } finally {
    await client.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

// Savepoint names must be plain identifiers.
const sp1 = 'sp_live_dup';
const sp2 = 'sp_url_dup';
const sp3 = 'sp_processing_dup';
const sp4 = 'sp_completed_dup';
const sp5 = 'sp_other_action';
const sp6 = 'sp_log_update';
const sp7 = 'sp_log_delete';

void main().catch((error) => {
  process.stderr.write(
    `\nVerification failed to run: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
