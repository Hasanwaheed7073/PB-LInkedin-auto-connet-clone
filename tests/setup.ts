import 'dotenv/config';

/**
 * Global test setup.
 *
 * Loads `.env` so tests use the same configuration as the app, then applies
 * test-only overrides. Nothing here reaches LinkedIn: the worker tests run
 * against the local fixture server in `tests/mock-linkedin`, and
 * `MOCK_LINKEDIN_BASE_URL` is refused by `workerEnv()` unless NODE_ENV is
 * `test`, so a stray fixture URL cannot leak into a real run.
 */

// `NODE_ENV` is typed read-only by @types/node; assigning through the record
// index is the supported way to set it for a test process.
(process.env as Record<string, string>).NODE_ENV = 'test';

// Deterministic limits so tests do not depend on whatever is in .env.
process.env.GLOBAL_DAILY_ACTION_LIMIT ??= '40';
process.env.MAX_CONNECTION_NOTE_CHARS ??= '280';
process.env.WORKER_HEARTBEAT_STALE_MS ??= '45000';

// PGlite accepts a single connection; see vitest.config.ts.
process.env.DATABASE_POOL_MAX = '1';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-000000';
}
if (!process.env.WORKER_API_TOKEN || process.env.WORKER_API_TOKEN.length < 32) {
  process.env.WORKER_API_TOKEN = 'test-worker-api-token-that-is-long-enough-0000';
}
