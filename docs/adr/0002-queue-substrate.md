# ADR-0002 — Job queue substrate

- **Status:** Proposed
- **Date:** 2026-08-29
- **Depends on:** [ADR-0001](./0001-language-and-runtime.md)

## Context

The brief proposes Redis with Celery "or an equivalent reliable job queue" for background
processing. The pipeline needs durable, retryable, per-record work with scheduling, and it already
has a PostgreSQL database that the work is written to anyway.

Expected throughput: 1,000–2,000 records/day across roughly eight stages — order 16,000 jobs/day,
or **0.2 jobs/second**.

## Decision

**Use PostgreSQL as the queue substrate** (`pg-boss` in the TypeScript stack; `SQLAlchemy` +
`FOR UPDATE SKIP LOCKED`, or Celery with a database broker, if ADR-0001 goes to Python).
Do not introduce Redis.

## Rationale

**Throughput is three orders of magnitude below where Postgres-as-a-queue struggles.** A single
Postgres instance handles thousands of queue operations per second with `SKIP LOCKED`. At 0.2/s the
queue is idle.

**Transactional consistency comes free.** Enqueueing the next stage and writing the current stage's
result happen in one transaction. With a separate broker they cannot, which produces the classic
pair of failures: work committed but never enqueued, or enqueued but never committed. Avoiding
dual-write reconciliation is worth more here than any throughput headroom Redis offers.

**The pattern is already proven in this codebase.** The outreach platform claims work with
`FOR UPDATE ... SKIP LOCKED`, re-verifies state inside the same transaction, and asserts the
required indexes exist via `npm run db:verify`. That is the hard part of a reliable queue, and it
is already written and tested here.

**One less stateful service.** Redis means another thing to provision, secure, monitor, back up,
and be woken by. Each added component needs to earn its operational cost; at this volume Redis
does not.

**Scheduling lands in the same place.** Schedules are rows, runs are rows, and the scheduler takes
a Postgres advisory lock for single-writer discipline. No second source of truth about what is
supposed to run.

## Consequences

- Queue depth, retries and dead-lettering are queryable with SQL, and visible in the dashboard with
  no extra integration.
- Backups cover the queue state along with everything else.
- Queue load lands on the same database as reads. At this volume that is immaterial; if it ever is
  not, the fix is a dedicated schema or instance before it is a different technology.

## When to revisit

- Sustained throughput above ~100 jobs/second.
- A need for fan-out pub/sub across many consumers, which is a different problem than a work queue.
- Sub-second latency requirements. This pipeline is batch-oriented; it has none.

Migrating from `pg-boss` to a dedicated broker later is contained, because stages communicate
through the database rather than through queue payloads: the queue carries a record id, not state.
