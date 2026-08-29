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

/**
 * Move SSL intent out of the connection string and into explicit options.
 *
 * Managed Postgres (Supabase's pooler among them) presents a certificate chain
 * that does not validate against the system trust store, and this `pg` version
 * treats a bare `sslmode=require` as full verification. The documented
 * workaround is `uselibpqcompat=true`, which works on some Node versions and,
 * on Node 24, *hangs the connection instead of failing it* — the worst possible
 * behaviour, because a timeout looks like a network problem rather than a
 * configuration one.
 *
 * Setting `ssl` directly is unambiguous across versions: the connection is
 * encrypted, and the certificate is not verified. That is the same security
 * posture the URL flags were asking for, stated where it cannot be
 * misinterpreted. Local Postgres (PGlite over plain TCP) keeps SSL off.
 */
export function resolveSsl(connectionString: string): {
  connectionString: string;
  ssl: PoolConfig['ssl'];
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, ssl: undefined };
  }

  const sslmode = url.searchParams.get('sslmode');
  const libpqCompat = url.searchParams.get('uselibpqcompat');
  const wantsSsl = sslmode !== null && sslmode !== 'disable';

  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');

  if (!wantsSsl && libpqCompat === null) {
    return { connectionString, ssl: undefined };
  }

  return {
    connectionString: url.toString(),
    // `verify-full` would need the provider's CA bundle shipped with the app.
    // Until that is done, this is encrypted-but-unverified, deliberately.
    ssl: sslmode === 'verify-full' ? true : { rejectUnauthorized: false },
  };
}

export function buildPoolConfig(options: PrismaFactoryOptions = {}): PoolConfig {
  const { connectionString, ssl } = resolveSsl(
    resolveConnectionString(options.connectionString),
  );

  const envMax = Number(process.env.DATABASE_POOL_MAX);
  const max =
    options.poolMax ?? (Number.isFinite(envMax) && envMax >= 1 ? Math.floor(envMax) : 1);

  return {
    connectionString,
    ssl,
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
