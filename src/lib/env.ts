import { z } from 'zod';

/**
 * Environment validation.
 *
 * Two separate schemas, deliberately:
 *  - `serverEnv` is only ever read from server components, route handlers and
 *    server actions. It holds database credentials and the worker token.
 *  - `workerEnv` is read by the standalone worker process, which must NOT have
 *    database credentials at all (see docs/IMPLEMENTATION_PLAN.md, P2).
 *
 * Nothing in this file is safe to import from a client component. There is no
 * `NEXT_PUBLIC_` value here on purpose: no secret, session detail or cookie is
 * ever exposed to the browser bundle.
 */

const nonEmpty = (name: string) =>
  z.string().min(1, `${name} is required - copy .env.example to .env and fill it in`);

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((v) => !/^replace-me/i.test(v), `${name} still holds the .env.example placeholder`);

const intFromEnv = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const serverSchema = z.object({
  DATABASE_URL: nonEmpty('DATABASE_URL'),
  DIRECT_DATABASE_URL: z.string().optional(),
  SESSION_SECRET: secret('SESSION_SECRET'),
  WORKER_API_TOKEN: secret('WORKER_API_TOKEN'),

  WORKER_HEARTBEAT_STALE_MS: intFromEnv(45_000, 5_000, 600_000),

  GLOBAL_DAILY_ACTION_LIMIT: intFromEnv(40, 0, 500),
  MAX_CONNECTION_NOTE_CHARS: intFromEnv(280, 1, 2_000),

  SCREENSHOT_DIR: z.string().default('./.data/screenshots'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const workerSchema = z.object({
  WORKER_API_TOKEN: secret('WORKER_API_TOKEN'),
  WORKER_API_BASE_URL: z.string().url('WORKER_API_BASE_URL must be an absolute URL'),
  WORKER_NAME: z.string().min(1).default('local-worker-1'),

  BROWSER_PROFILE_DIR: z.string().default('./.data/browser-profile'),
  SCREENSHOT_DIR: z.string().default('./.data/screenshots'),

  WORKER_HEADLESS: boolFromEnv(false),
  WORKER_HEARTBEAT_INTERVAL_MS: intFromEnv(10_000, 1_000, 120_000),
  WORKER_CONTROL_POLL_MS: intFromEnv(3_000, 500, 60_000),
  WORKER_JOB_TIMEOUT_MS: intFromEnv(120_000, 10_000, 900_000),
  WORKER_NAV_TIMEOUT_MS: intFromEnv(45_000, 5_000, 300_000),

  /**
   * Test-only escape hatch. When set, the worker treats this as the origin for
   * profile URLs instead of linkedin.com, so the whole worker can be exercised
   * against local fixtures. Refused unless NODE_ENV is `test`.
   */
  MOCK_LINKEDIN_BASE_URL: z.string().url().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

let cachedServerEnv: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment configuration:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

let cachedWorkerEnv: WorkerEnv | null = null;

export function workerEnv(): WorkerEnv {
  if (cachedWorkerEnv) return cachedWorkerEnv;
  const parsed = workerSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid worker environment configuration:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  if (parsed.data.MOCK_LINKEDIN_BASE_URL && parsed.data.NODE_ENV !== 'test') {
    throw new Error(
      'MOCK_LINKEDIN_BASE_URL is set but NODE_ENV is not "test". Refusing to start: this ' +
        'would silently point the worker at a fixture server instead of LinkedIn.',
    );
  }
  cachedWorkerEnv = parsed.data;
  return cachedWorkerEnv;
}

/** Test helper - forget memoised values after mutating process.env. */
export function resetEnvCache(): void {
  cachedServerEnv = null;
  cachedWorkerEnv = null;
}
