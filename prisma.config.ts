import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * From Prisma 7 the connection URL lives here rather than in `schema.prisma`.
 * Only the CLI (migrate, db, studio) reads this file; the application connects
 * through the `@prisma/adapter-pg` driver adapter in `src/lib/db.ts`.
 *
 * `DIRECT_DATABASE_URL` matters on Supabase: migrations cannot run over the
 * transaction pooler on port 6543, so the CLI uses the direct 5432 connection
 * while the app uses the pooled one.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  datasource: {
    url: env('DIRECT_DATABASE_URL') ?? env('DATABASE_URL'),
  },

  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
