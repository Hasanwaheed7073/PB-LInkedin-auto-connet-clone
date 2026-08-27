/**
 * Local PostgreSQL for development and tests.
 *
 * Starts a real PostgreSQL server (PGlite - upstream PostgreSQL compiled to
 * WebAssembly) and exposes it on a TCP port, so `prisma migrate`, the app and
 * the integration tests all speak the ordinary Postgres wire protocol to it.
 * No Docker and no system Postgres install needed.
 *
 * Why a real Postgres rather than SQLite: the duplicate-protection guarantees in
 * this project are partial unique indexes and `FOR UPDATE ... SKIP LOCKED`, and
 * SQLite can express neither. Testing against SQLite would silently skip the
 * most important safety property in the system.
 *
 * KNOWN LIMITATION: PGlite runs a single WASM Postgres instance, so concurrent
 * connections are serialised onto it. That is fine for migrations, for the app,
 * and for every test in `tests/integration`, but it means a true
 * two-workers-race test cannot run here. The test that needs genuine
 * concurrency is skipped unless `TEST_CONCURRENT_DATABASE_URL` points at a real
 * multi-connection PostgreSQL (a Supabase branch works). See
 * tests/integration/claim-concurrency.test.ts.
 *
 * Usage:
 *   npm run db:local              # start, stay in the foreground
 *   npm run db:local -- --reset   # wipe the data directory first
 */

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import 'dotenv/config';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const PORT = Number(process.env.LOCAL_PG_PORT ?? 55432);
const HOST = '127.0.0.1';
const DATA_DIR = resolve(process.env.LOCAL_PG_DATA ?? './.pgdata');

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  if (reset) {
    process.stdout.write(`Removing ${DATA_DIR}\n`);
    await rm(DATA_DIR, { recursive: true, force: true });
  }

  process.stdout.write(`Starting PostgreSQL (PGlite) with data dir ${DATA_DIR}\n`);
  const db = await PGlite.create({ dataDir: DATA_DIR });

  const version = await db.query<{ version: string }>('SELECT version()');
  process.stdout.write(`${version.rows[0]?.version ?? 'unknown version'}\n`);

  const server = new PGLiteSocketServer({ db, port: PORT, host: HOST });
  await server.start();

  process.stdout.write(
    `\nListening on ${HOST}:${PORT}\n` +
      `Connection string (any user/password is accepted):\n` +
      `  postgresql://outreach:outreach@${HOST}:${PORT}/outreach?schema=public&connection_limit=1\n\n` +
      'Leave this running, then in another terminal:\n' +
      '  npm run db:deploy   # apply migrations\n' +
      '  npm run db:seed     # create the operator account\n' +
      '  npm run dev         # start the dashboard\n\n' +
      'Press Ctrl+C to stop.\n',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}; stopping PostgreSQL\n`);
    try {
      await server.stop();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((error) => {
  process.stderr.write(
    `Failed to start local PostgreSQL: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
