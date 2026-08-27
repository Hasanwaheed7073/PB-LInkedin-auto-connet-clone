import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { PoolConfig } from 'pg';

/**
 * Prisma client construction, shared by the app, the seed script and the tests.
 *
 * Prisma 7 connects through a driver adapter, so the pool is ours to configure.
 * That matters here for one specific reason:
 *
 * The local development database (`npm run db:local`) is PGlite - real
 * PostgreSQL compiled to WebAssembly - fronted by a socket server that accepts
 * a SINGLE connection. A pool that opens a second connection gets it dropped
 * mid-query. Setting `max: 1` makes the pool serialise everything onto one
 * connection, so `Promise.all` of several queries queues instead of failing.
 *
 * Against a normal PostgreSQL or Supabase, raise `DATABASE_POOL_MAX`. The
 * default of 1 is the safe choice: correct everywhere, just slower under
 * concurrency than a real server allows.
 */

export interface PrismaFactoryOptions {
  /** Overrides `DATABASE_URL`. */
  connectionString?: string;
  /** Overrides `DATABASE_POOL_MAX`. */
  poolMax?: number;
  log?: boolean;
}

export function resolveConnectionString(override?: string): string {
  const url = override ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set - copy .env.example to .env and fill it in.');
  }
  return url;
}

export function buildPoolConfig(options: PrismaFactoryOptions = {}): PoolConfig {
  const connectionString = resolveConnectionString(options.connectionString);

  const envMax = Number(process.env.DATABASE_POOL_MAX);
  const max =
    options.poolMax ?? (Number.isFinite(envMax) && envMax >= 1 ? Math.floor(envMax) : 1);

  return {
    connectionString,
    max,
    // A short idle timeout keeps the single local connection from being held
    // open across a long dev session.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  };
}

export function createPrismaClient(options: PrismaFactoryOptions = {}): PrismaClient {
  const adapter = new PrismaPg(buildPoolConfig(options));

  return new PrismaClient({
    adapter,
    log:
      options.log ?? process.env.NODE_ENV === 'development'
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  });
}
