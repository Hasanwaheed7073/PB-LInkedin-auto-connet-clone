# LinkedIn Outreach Operations Platform

An internal tool for working one lead list of roughly 600 LinkedIn profiles: import the list,
configure a campaign, and let a supervised browser worker send connection requests on a schedule
while you are away from the machine.

It is built to be boring and safe. The interesting engineering is in the parts that stop it doing
something wrong.

## What it does not do

This matters more than the feature list, so it is first.

- **No CAPTCHA solving.** If a CAPTCHA appears, the worker stops and asks for a person.
- **No fingerprint spoofing, no stealth plugins, no proxy rotation, no user-agent faking.** The
  browser is stock Chromium with default flags.
- **No rate-limit circumvention.** Limits here are your own configured ceilings, enforced downward.
  Adding campaigns cannot increase total volume.
- **No account farming, no detection evasion.**
- **No LinkedIn credentials anywhere.** Not in the database, not in `.env`, not in a form. You sign
  in by hand, once, in a real browser window.

When a CAPTCHA, security challenge, account restriction, or any unrecognised page appears, the
worker halts, opens an incident, and refuses to run again until a human resolves it. Unrecognised
pages are treated as dangerous, not as "probably fine".

`MESSAGE`, `FOLLOW` and `PROFILE_VISIT` exist in the queue schema so adding them later needs no
migration. They are **not implemented**, and the worker fails such a job explicitly rather than
pretending to run it.

## Safety architecture

Four independent layers make a duplicate invitation impossible. Each is sufficient on its own.

1. `leads.linkedinUrl` is globally unique on a normalised URL — one row per person, ever, across
   every campaign.
2. A partial unique index allows at most **one live job** per (lead, action):
   `WHERE status IN ('WAITING','PROCESSING')`.
3. A partial unique index allows at most **one resolved job** per (lead, action):
   `WHERE status = 'COMPLETED'`. Once a CONNECT is resolved for someone — sent, already connected,
   or already pending — a second completion cannot be written.
4. `claimNextJob` takes the row with `FOR UPDATE ... SKIP LOCKED` and re-verifies lead state
   *inside the same transaction*, including `leads.invitationSentAt`.

On top of that:

- **One worker at a time.** An exclusive run lease is granted at registration. A second worker is
  refused while the holder's heartbeat is fresh; taking over needs an explicit `--force-takeover`.
- **The click is never the proof.** Every action does detect → act → **re-read the page** → decide.
  The result written to the database comes from the re-read. If the page does not confirm the
  invitation, the outcome is not `SENT`.
- **The activity log is append-only**, enforced by a database trigger, not by convention.
- **The emergency stop is persisted**, so it survives a restart of both the app and the worker, and
  it interrupts work already in flight (the worker polls the control gate every few seconds).
- **Clearing the stop is refused** while any blocking incident is unresolved.

Run `npm run db:verify` to confirm all of this in your actual database rather than taking this
file's word for it.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · PostgreSQL · Prisma 7 ·
Playwright · Zod · React Hook Form · Vitest

The worker is a standalone Node process. It holds **no database credentials** and talks to the
dashboard only over an authenticated HTTP API, so it can be moved to another machine unchanged.

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then generate the two secrets and paste them in:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # WORKER_API_TOKEN
```

Set `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` for the dashboard operator account. This password is
for **this dashboard** — it has nothing to do with LinkedIn.

### 3. Set up the database

**Option A — local PostgreSQL, no Docker needed.** Runs a real PostgreSQL server (PGlite: upstream
PostgreSQL compiled to WebAssembly) on port 55432.

```bash
npm run db:local        # leave this running in its own terminal
```

**Option B — Supabase or any PostgreSQL.** Point `DATABASE_URL` at the pooled connection and
`DIRECT_DATABASE_URL` at the direct one (port 5432). Migrations cannot run over a transaction
pooler, which is why both exist. Raise `DATABASE_POOL_MAX` above `1` for a real server.

The schema is PostgreSQL-only and must stay that way: the duplicate protection above relies on
partial unique indexes and `SKIP LOCKED`, and SQLite can express neither.

### 4. Run migrations

```bash
npm run db:deploy
npm run db:verify     # proves the safety constraints exist in the live database
```

### 5. Seed the operator account

```bash
npm run db:seed
```

No demo leads or example campaigns are created. The dashboard only ever shows real data.

### 6. Start the dashboard

```bash
npm run dev
```

Open <http://localhost:3000> and sign in.

### 7. Authenticate the browser session — by hand, once

```bash
npm run worker -- --login
```

A real Chromium window opens at the LinkedIn sign-in page. **You** sign in, including any
two-factor step or verification LinkedIn asks for. Nothing is typed, filled or solved
programmatically. Once a signed-in session is detected it is saved to the persistent profile in
`BROWSER_PROFILE_DIR` and the window closes.

Treat that directory like a password store: it grants access to the logged-in session. It is
gitignored; keep it off shared drives.

### 8. Import your CSV

Dashboard → **Leads → Import CSV**. One column must hold the profile URL. You get a full preview —
how many will import, how many are duplicates within the file, how many already exist, and every
rejected row with a reason — and nothing is written until you confirm.

### 9. Create a message template (optional)

Dashboard → **Templates**. Supports `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{jobTitle}}`.

The preview renders against a **real lead from your database**, never an invented example, and tells
you how many leads the template would fail for. A lead whose values cannot fill the template is
skipped rather than sent a note with a gap in it.

### 10. Create a campaign

Dashboard → **Campaigns → New campaign**. Set the timezone, operating window, operating days, daily
limit and spacing. Campaigns are created as `DRAFT`.

### 11. Review the queue

On the campaign page, **Generate queue** creates one job per pending lead, spread across the
operating window within the daily limit. Check **Queue** to see exactly what would run and when.

### 12. Activate

On the campaign page, **Activate**. Pre-flight checks must pass first, and the confirmation dialog
spells out what is about to happen. This is the only path to `RUNNING`.

### 13. Start the worker

```bash
npm run worker
```

It registers, takes the run lease, opens the browser profile, verifies the session, then begins
claiming jobs. `npm run worker:once` processes a single job and exits — useful for a first
supervised run.

## Everyday operation

| Command | What it does |
| --- | --- |
| `npm run dev` | dashboard on :3000 |
| `npm run worker` | the browser worker |
| `npm run worker:once` | process one job, then exit |
| `npm run worker -- --login` | interactive sign-in |
| `npm run worker -- --force-takeover` | seize the run lease from a dead worker |
| `npm run db:local` | local PostgreSQL |
| `npm run db:verify` | assert the safety constraints exist |
| `npm run db:studio` | browse the database |
| `npm test` | full test suite |
| `npm run mock:linkedin` | fixture server, for exercising the worker offline |

### When something goes wrong

The dashboard header always shows worker status, session status, and whether automation is stopped.

- **STOP ALL** is on every screen. It halts the worker mid-action, pauses every campaign, cancels
  waiting jobs, and records the reason you type in the audit log.
- **Incidents** is the human intervention queue: the reason, the affected lead, a screenshot path
  where one was captured, and the actions — resume, skip lead, requeue lead, block lead, stop
  campaign.
- **Recovery sweep** requeues jobs abandoned by a worker that died mid-job and flags stale workers.
  It deliberately does not start a replacement worker.

Screenshots are written to `SCREENSHOT_DIR` and are **not** served over HTTP, because a screenshot
of a signed-in page can contain session detail. Open them from disk.

## Testing

```bash
npm test                  # everything
npm run test:unit         # pure logic, no database, no browser
npm run test:integration  # against the real database
npm run test:worker       # real Chromium against local fixtures
```

Integration and worker tests need `npm run db:local` running and migrations applied.

The worker tests drive a real Chromium against the fixture server in `tests/mock-linkedin`, which
reproduces the shape of each page state the detector recognises — connect available, already
connected, invitation pending, profile missing, CAPTCHA, security challenge, account restricted,
signed out, and an unrecognised page. **Nothing in the test suite contacts linkedin.com**, and
`workerEnv()` refuses to start with a fixture URL unless `NODE_ENV=test`.

### Known limitation of the local database

PGlite is a single PostgreSQL instance behind a socket server that accepts one connection at a
time. That is fine for migrations, the app and every test here, but a genuine two-workers-race test
cannot run against it. `tests/integration/claim-concurrency.test.ts` skips itself unless
`TEST_CONCURRENT_DATABASE_URL` points at a real multi-connection PostgreSQL. Against such a server
it runs and asserts that concurrent claims never collide.

## Architecture

```
src/
├── app/
│   ├── (app)/              dashboard, leads, campaigns, queue, activity, incidents, worker, settings
│   ├── login/
│   └── api/worker/         register · heartbeat · control · claim · complete · fail · incident · stopped
├── components/             UI, shadcn/ui primitives in components/ui
├── lib/
│   ├── queue.ts            generation, transactional claiming, completion, failure, recovery
│   ├── schedule.ts         operating hours, timezones, daily limits, backoff  (pure)
│   ├── page-state-policy.ts  what each detected page state MEANS              (pure)
│   ├── safety.ts           emergency stop, the worker gate
│   ├── incidents.ts        human intervention queue
│   ├── linkedin-url.ts     URL normalisation = lead identity                  (pure)
│   ├── csv.ts              import analysis                                    (pure)
│   ├── template.ts         note rendering                                     (pure)
│   ├── activity.ts         append-only audit log
│   └── workers.ts          registry, exclusive lease, health
├── server/actions/         validated server actions
└── worker/
    ├── main.ts             the loop: gate → claim → act → verify → report
    ├── page-state.ts       deterministic detection
    ├── actions/connect.ts  the CONNECT action, with mandatory verification
    ├── browser.ts          persistent profile, interactive login
    └── api-client.ts       the only way the worker reaches state
```

### Deterministic by design

No model is in the control path. Queue management, scheduling, state transitions, browser actions
and every safety check are ordinary deterministic code. `src/lib/page-state-policy.ts` is a plain
lookup table, so the safety-critical decisions can be reviewed in one place and are unit-tested as
properties over the whole enum — adding a page state without deciding its policy fails the build.

If AI is added later it belongs in lead qualification, message personalisation, profile
summarisation, or classifying genuinely ambiguous page content — never in deciding whether to click
send.

## Notes on this environment

Two things worth knowing if you work on this checkout:

- The project sits on `D:`, a spinning SATA disk, while `C:` is an NVMe SSD. Installing ~28,600
  dependency files directly onto `D:` was pathologically slow and kept stalling, so dependencies
  were installed on the SSD and copied across with `robocopy`. `node_modules` here is a **real
  directory** and must stay one: a cross-drive junction does not work, because Turbopack rejects it
  ("points out of the filesystem root") and webpack builds broken relative paths from it. If
  `npm install` crawls, that is why — install into a temp directory on `C:` and copy the result in.
- `npm run db:local` keeps its data in `LOCAL_PG_DATA`, pointed at the SSD in `.env`. Leaving it on
  `D:` made the integration suite take 71 seconds instead of 8.
- One `next build` here emitted `failed to sync file ... The request failed due to a fatal device
  hardware error (os error 483)` while persisting its Turbopack cache. The build itself completed
  and all 22 routes compiled, so this did not affect output — but a device-level I/O error on `D:`
  is worth taking seriously. Consider checking that disk's health (`chkdsk`, SMART) before relying
  on it for anything you care about.

## Facts this document does not assert

LinkedIn's own limits are not published as stable numbers and change by account type and tenure, so
nothing here claims to know them. `GLOBAL_DAILY_ACTION_LIMIT` defaults to a deliberately
conservative 40/day and `MAX_CONNECTION_NOTE_CHARS` to 280 — both are **your** configured ceilings,
not derived from any documented LinkedIn allowance. Set them to whatever you have decided is
appropriate; the system only ever enforces them downward.
