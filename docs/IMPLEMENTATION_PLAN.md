# Implementation plan and build record

This started as the plan required by task 27 and has been kept current as the build progressed, so
it now doubles as a record of what was decided and why. Where a decision changed during the build,
the change and its reason are recorded rather than the original guess being quietly edited out.

## 0. Repository inspection (task 27, steps 1-3)

The working directory `D:\Linkedin auto connection request` was **completely empty** - no
`package.json`, no git repository, no source files. There was no existing stack to identify and
nothing to reuse or preserve, so the "do not rewrite the project unnecessarily" constraint was
vacuous.

Toolchain actually present:

| Tool | Version | Notes |
| --- | --- | --- |
| Node | v24.18.0 | fine for Next 16 |
| npm | 11.16.0 | registry reachable |
| git | 2.55.0 | no repository initialised (not requested) |
| Docker | **absent** | cannot run a containerised Postgres |
| `psql` / system Postgres | **absent** | no database server |

## 1. Dependencies (task 27, step 5)

Nothing was installed. Final set, pinned:

- `next@16.3.3` + `react@19.2` - App Router. (The brief said "14+"; 16.3 is the current stable line.)
- `prisma` / `@prisma/client` @ **7.10.0**. Note `npm latest` for `prisma` is `8.0.0-rc`, a release
  candidate; the stable `7.10.0` (`prev` dist-tag) is pinned deliberately.
- `@prisma/adapter-pg` + `pg` - required, see D2.
- `tailwindcss@4.3` - CSS-first config, no `tailwind.config.ts`.
- shadcn/ui component sources vendored into `src/components/ui` on Radix primitives.
- `playwright@1.62`, `zod@4`, `react-hook-form`, `luxon` (IANA timezone arithmetic), `papaparse`,
  `jose` (signed session cookie), `dotenv`, `vitest@4`.
- `@electric-sql/pglite` + `@electric-sql/pglite-socket` (dev only) - see D1.

## 2. Architectural decisions

### D1 - No database was available, and the design needs *real* PostgreSQL

The duplicate-protection requirements (§16) cannot be met without PostgreSQL specifically:
`SELECT ... FOR UPDATE SKIP LOCKED` for transactional claiming, and **partial unique indexes** to
make a duplicate invitation impossible at the storage layer. SQLite can express neither, so "just
use SQLite for dev" would have silently downgraded the single most important safety property in the
brief.

**First attempt:** `embedded-postgres`, which downloads real Postgres binaries. Abandoned - it is
prerelease-only, and its install repeatedly stalled on this machine (see D5).

**Shipped:** `npm run db:local` starts PGlite - upstream PostgreSQL 18.3 compiled to WebAssembly -
behind a TCP socket server, so Prisma, `prisma migrate` and the tests all speak the ordinary
Postgres wire protocol to a genuinely PostgreSQL server. No Docker, no system install.

Two PGlite limitations were found by running against it, and both are documented where they matter:

1. **One connection at a time.** Hence `DATABASE_POOL_MAX` (default `1`) and a shared Prisma client
   in the test helpers rather than one per test file.
2. **A query error drops the connection and does not recover it** - including an expected
   constraint violation or a trigger exception. Five tests that deliberately provoke a database
   error therefore skip on PGlite and run against a real server; they are covered meanwhile by
   `npm run db:verify`, which probes the same constraints on a single raw connection using
   savepoints. This is called out in the test files and the README rather than papered over.

### D2 - Prisma 7 moved connection URLs out of the schema

`datasource { url = env(...) }` is rejected by Prisma 7: URLs belong in `prisma.config.ts`, and the
client connects through a driver adapter. So `prisma.config.ts` carries the CLI's URL (preferring
`DIRECT_DATABASE_URL`, because migrations cannot run over a Supabase transaction pooler) and
`src/lib/prisma-factory.ts` builds the client on `@prisma/adapter-pg`.

### D3 - Where the claiming logic lives

The worker must run independently of the dashboard, and §21 forbids leaking credentials outward. If
the worker held a Prisma connection, the worker host would need database credentials.

All claim/complete/fail/heartbeat logic therefore lives in `src/lib/queue.ts` as functions over
Prisma, exposed over authenticated HTTP (`Authorization: Bearer $WORKER_API_TOKEN`) at
`/api/worker/*`. The worker speaks **only** HTTP and holds no database credentials. The dashboard
calls the same functions in-process.

### D4 - Four independent layers against a duplicate invitation

`SKIP LOCKED` alone stops two workers grabbing the *same* job, but not two workers each sending to
the same person. So:

1. **Worker lease** - `/api/worker/register` grants one exclusive lease; a second worker is refused
   while the holder's heartbeat is fresh (`--force-takeover` required, never inferred).
2. **`SKIP LOCKED` claiming**, re-verifying lead state inside the claim transaction.
3. **Partial unique index** `(leadId, action) WHERE status IN ('WAITING','PROCESSING')` - at most one
   live job per lead per action.
4. **Partial unique index** `(leadId, action) WHERE status = 'COMPLETED'` - a resolved action can
   never be recorded twice, so a duplicate cannot be written even if everything above is bypassed.

Plus `leads.linkedinUrl` globally unique on a normalised URL, and `leads.invitationSentAt` checked
before every claim.

### D5 - The project is on a spinning disk

`D:` is a SATA HDD; `C:` is NVMe SSD. Installing ~28,600 dependency files onto `D:` was
pathologically slow and repeatedly stalled. Dependencies were installed on the SSD and then copied
across with `robocopy`.

A cross-drive `node_modules` **junction** was tried first and does not work: Turbopack rejects it
outright ("points out of the filesystem root") and webpack builds broken relative paths from it. So
`node_modules` must be a real directory in the project. The PGlite data directory, which has no such
constraint, is pointed at the SSD via `LOCAL_PG_DATA` - that alone took the integration suite from
71 seconds to 8.

### D6 - Note rendering belongs on the server

Initially the worker rendered the connection note from a template. Moved server-side: the server
owns the template, the lead data and the configured length ceiling, so it sends the worker finished
text plus a `noteRenderError`. The worker now has no template logic and cannot produce a
half-substituted note; when the note cannot be rendered it skips the lead **without loading the
profile**, so a template problem costs no activity budget.

### D7 - Clicking is not proof

Every action does navigate → detect → act → **re-read the page** → decide, and the value written to
the database comes from the re-read. `src/lib/page-state-policy.ts` holds the consequences of each
detected state as plain data, so the safety-critical decisions sit in one reviewable place and are
unit-tested as properties over the whole enum - adding a `PageState` without deciding its policy
fails the build.

## 3. Problems found by actually running it

These are recorded because each was a real defect that testing caught, not a hypothetical.

| Found by | Defect | Fix |
| --- | --- | --- |
| Unit test | `nameFromSlug` dropped real names - `ada`, `bea`, `dee`, `cade` are all valid hex, so the "looks like a hash" filter ate them | Drop only segments containing a digit |
| Unit test | `buildSchedule` scheduled jobs for a campaign with **no operating days**, because `nextWindowOpen` returned null and the code fell back to "now" | Return an empty schedule; also removed a pathological slow path |
| Detector test | "detects a CAPTCHA from the DOM" was passing via the *URL* rule, because the fixture slug contained the word `captcha` | Renamed fixture slugs so DOM detection is genuinely exercised |
| Detector test | Detection took ~48s per unrecognised page: ~40 selectors probed **sequentially** at 1.2s each | Probe concurrently, preserving selector priority; 549s → 98s |
| Integration test | Deleting an uncontacted lead failed. `activity_logs` has `ON DELETE SET NULL` FKs, PostgreSQL implements SET NULL as an UPDATE, and the append-only trigger rejected it | Trigger now permits exactly one shape of UPDATE - all content columns identical, FK columns only unchanged or nulled |
| End-to-end run | An unprocessable profile left the lead as `FAILED`, but §8 step 10 says mark `REQUIRES_REVIEW` | Added `UNPROCESSABLE_POLICY`; lead and job both go to `REQUIRES_REVIEW` |
| End-to-end run | `npm run worker` failed outright - the standalone worker never loaded `.env` | `import 'dotenv/config'` at the top of `src/worker/main.ts` |
| Page render | Server-rendered shell passed Lucide icon *components* to a client component, which React refuses to serialise | Moved the whole nav into the client component |

## 4. Verification performed

- `npm run typecheck` - 0 errors across 100+ files.
- `npm test` - **370 passed, 7 skipped, 0 failed** across 13 files.
- `npm run db:verify` - 28/28 database guarantees confirmed against the live schema, including both
  partial unique indexes, case-insensitive URL uniqueness, the append-only trigger, `SKIP LOCKED`,
  and the exact job-claiming CTE.
- `next build` - all 22 routes compiled.
- Every page requested and confirmed `200` with real data; unauthenticated requests `307` to
  `/login`.
- **End-to-end**: the real worker process, real Chromium, real HTTP API and real database driven
  against the mock-LinkedIn fixtures. Five leads produced exactly the intended outcomes - `SENT`
  (verified by re-reading the page), `ALREADY_CONNECTED`, `ALREADY_PENDING`, `SKIPPED` for a missing
  profile, and `REQUIRES_REVIEW` with a non-blocking incident for an unactionable one. One activity
  record per action; nothing sent where nothing should be.

The 7 skipped tests are all deliberate and explained in place: 5 need a database that survives an
expected error, 2 need genuine multi-connection concurrency. Both sets run against a real
PostgreSQL via `TEST_CONCURRENT_DATABASE_URL`.

## 5. Explicitly out of scope, by instruction

No CAPTCHA solving, no fingerprint spoofing, no stealth plugins, no proxy rotation, no account
farming, no rate-limit circumvention, no detection evasion. Detected challenges **stop** the worker
and escalate to a human.

`MESSAGE`, `FOLLOW` and `PROFILE_VISIT` exist in the action enum so adding them needs no migration.
They are **not implemented**, and the worker fails such a job explicitly rather than pretending
(§26). The Settings page lists them, and the other deliberate omissions, as not implemented.
