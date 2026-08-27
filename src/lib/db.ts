import type { PrismaClient } from '@prisma/client';

import { createPrismaClient } from './prisma-factory';

/**
 * Prisma client singleton.
 *
 * Server-side only. The worker process never imports this - it holds no
 * database credentials and reaches the database exclusively through the
 * authenticated `/api/worker/*` routes.
 */

declare global {
  // eslint-disable-next-line no-var
  var __outreachPrisma: PrismaClient | undefined;
}

// Reuse across hot reloads in dev so we do not exhaust the connection pool.
export const prisma: PrismaClient = globalThis.__outreachPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__outreachPrisma = prisma;
}

/**
 * Postgres error code for a unique-constraint violation. The duplicate-protection
 * layer relies on catching this rather than pre-checking, because a pre-check is
 * racy and the index is not.
 */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002' || code === PG_UNIQUE_VIOLATION) return true;
  // Driver-adapter errors can carry the Postgres code one level down.
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code === PG_UNIQUE_VIOLATION;
}
