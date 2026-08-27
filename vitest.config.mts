import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * `singleFork` and `fileParallelism: false` are deliberate, not laziness: the
 * local development database is PGlite behind a socket server that accepts one
 * connection at a time, so integration tests must not run concurrently. They
 * also share one database, and running them in parallel would have them
 * truncating each other's rows.
 *
 * The one test that needs genuine multi-connection concurrency
 * (tests/integration/claim-concurrency.test.ts) skips itself unless
 * TEST_CONCURRENT_DATABASE_URL points at a real PostgreSQL server.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Vitest 4: former `poolOptions` are top-level. One worker, no file
    // parallelism - the local PGlite database accepts a single connection and
    // all integration tests share it.
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    // Playwright-driven worker tests launch a browser and load fixture pages.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: process.env.CI ? ['default'] : ['default'],
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      '~/tests': resolve(import.meta.dirname, './tests'),
    },
  },
});
