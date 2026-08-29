# ADR-0001 — Pipeline language and runtime

- **Status:** Proposed — *requires your decision before Phase 2*
- **Date:** 2026-08-29
- **Decision owner:** project sponsor
- **Supersedes:** nothing

## Context

The brief proposes Python, FastAPI, Pydantic, SQLAlchemy and Celery/Redis for the backend, with a
Next.js/TypeScript dashboard, and invites a technically-grounded challenge.

The repository already contains a live, deployed TypeScript system: Next.js 16, Prisma 7,
PostgreSQL on Supabase, deployed on Vercel, with 206 passing tests. Three components are directly
load-bearing for the new engine:

- `src/lib/linkedin-url.ts` — canonical profile identity, 49 unit tests. This is the spine of
  deduplication.
- `src/lib/csv.ts` — shape-agnostic CSV reading (header-row detection, content-based column
  detection), which the import provider needs.
- `src/lib/icp.ts` — the explainable rule-scoring pattern that client-fit scoring generalises.

The decision is not "which language is better". It is: **does the pipeline share a runtime with the
dashboard, or is this a two-language system?**

## Decision

**Recommend TypeScript end-to-end.** Pipeline stages run in a long-lived Node process; the
dashboard and API stay in the existing Next.js app; PostgreSQL and Prisma throughout.

The signal and scoring engines are defined behind a narrow, versioned interface
(`ScoringEngine.score(candidate, profile) -> ScoreResult`) so they can later be moved
out-of-process — in Python — without touching the database, the dashboard, or the pipeline runner.

## Rationale

**1. Deduplication correctness is the highest-risk logic, and it already exists and is tested.**
URL canonicalisation is deceptively hard: country subdomains, percent-encoding, case folding,
trailing paths, Sales Navigator URLs that identify nothing public. Reimplementing it in Python
restarts that edge-case discovery from zero, and a *second* implementation is worse than either
one alone — two normalisers that disagree produce duplicate people, which is the exact failure the
system exists to prevent.

**2. One definition of the domain, not two kept in sync by hand.** The signal taxonomy, scoring
profile shape, decay curve and lead DTOs are consumed by both the pipeline and the dashboard. In a
split stack they exist twice — Pydantic and TypeScript — and drift silently. Zod schemas are already
the validation vocabulary here and can be the single source for both sides.

**3. Volume does not justify a second runtime.** 2,000 records/day is roughly 0.02 records/second.
Nothing in this workload is CPU-bound; it is I/O against providers and the database. Python's
concurrency story offers nothing at this scale that Node does not already have, and the pipeline's
per-record stage model (rather than in-memory batch processing) is a natural fit for async I/O.

**4. Operational surface.** One language, one dependency manager, one test runner, one CI
configuration, one deployment idiom. A two-language system needs all of it twice, plus an HTTP
contract between halves that has to be versioned, authenticated and monitored — real work that buys
nothing until there is a reason for the split.

**5. It is already deployed and running.** Migrations, safety verification, seeding, auth and
audit patterns all exist and work.

## Where this decision is wrong

Python wins decisively if the signal engine moves to **locally-hosted transformer models,
embeddings, or fine-tuning**. `transformers`, `sentence-transformers`, `spaCy`, `scikit-learn` and
the surrounding tooling have no serious TypeScript equivalent, and pretending otherwise would be
the kind of advice that looks fine in a document and painful in month four.

Calling a hosted LLM over HTTPS needs no Python — that is a JSON request. *Running* a model does.

**So the question to answer is:** within roughly six months, do you expect to train, fine-tune, or
self-host a classification model, or run embedding-based similarity over the corpus?

- **No / unsure** → TypeScript end-to-end, as recommended. The scoring interface keeps the door open.
- **Yes, definitely** → adopt the split now, deliberately: TypeScript dashboard and pipeline,
  Python scoring service behind the versioned HTTP contract. Adopting it later is a refactor of one
  module; adopting it *by accident*, after Python has spread across identity and persistence, is not.

A third path exists and I do not recommend it: full Python rewrite including the dashboard. It
discards a working, deployed, tested system to remove a language boundary that the interface above
already contains.

## Consequences

**Accepting:**
- Reuse of tested identity, CSV and scoring-rule code.
- Single type definition across pipeline and UI.
- One deployment pipeline; the existing one.
- The ML-heavy path costs one service extraction later rather than nothing now.

**Rejecting (going Python):**
- Reimplement and re-test URL canonicalisation and CSV shape detection.
- Maintain duplicate domain models across two languages.
- Operate and deploy two runtimes.
- Gain a materially better ML ecosystem, and a team that may simply be more productive in Python —
  which is a legitimate reason on its own, and one only you can weigh.

## Open question for the decision maker

Which is true of the next six months: hosted-LLM calls only (→ TypeScript), or self-hosted /
fine-tuned models (→ plan the split now)?
