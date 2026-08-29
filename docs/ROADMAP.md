# Roadmap and MVP Sequence

Status: **proposal, awaiting review.** No implementation has started.

Complexity is stated in engineer-weeks for one experienced full-stack engineer, and as a
**confidence** rating — how much I trust the estimate. Low confidence marks work whose size depends
on an unknown (usually a vendor's real behaviour or a source's real yield).

---

## Sequencing principle

The pipeline is built **back to front**: the parts whose correctness is hardest to retrofit go
first, and discovery — the part everyone wants to start with — is deliberately last of the core
work, behind a measurement spike.

The reason is that identity, provenance and lifecycle are load-bearing. Retrofitting deduplication
onto a populated database means reconciling records that outreach has already touched. Adding
provenance later means every field written before that point is unattributable and has to be
thrown away. Discovery, by contrast, is genuinely pluggable — that is the entire point of the
provider abstraction — so it can arrive late without disturbing anything.

---

## Phase 0 — Discovery yield spike *(2 weeks, confidence: high that it is needed)*

**Throwaway scripts. No schema, no pipeline, no UI.**

One question: what is the real daily yield of credible, contactable, in-ICP job seekers, per
source? Method and deliverable in [`DISCOVERY.md`](./DISCOVERY.md) §6. Hand-label 200 records per
source to get an honest precision figure.

**Gate:** the measured achievable daily volume, and a decision on whether the 500–600/day target
stands, is revised, or is funded through licensed data and an owned funnel.

Everything after this is sized by that answer. Skipping this phase means choosing the architecture's
scale by guess.

| Also decided here | |
| --- | --- |
| ADR-0001 | TypeScript or Python for the pipeline |
| Legal | Whether EU/UK subjects are in scope at launch |
| Budget | Licensed-data spend, if any |

---

## Phase 1 — Foundations *(3–4 weeks, confidence: high)*

The spine. No discovery beyond CSV import; the pipeline is exercised entirely from files, which
makes every downstream stage testable on day one without a network.

| Module | Weeks | Confidence | Notes |
| --- | --- | --- | --- |
| Schema + migrations | 0.75 | High | Additive to the existing Prisma project |
| Identity keys + resolution | 1.0 | Medium | Reuses tested `normalizeLinkedInUrl`; merge review UI deferred |
| Provenance (`field_observation` + triggers) | 0.5 | High | Mirrors the existing append-only log |
| Lifecycle state machine + transitions | 0.5 | High | DB-enforced, including the absorbing `DO_NOT_CONTACT` |
| Suppression | 0.25 | High | Small, and the highest-consequence control in the system |
| CSV import provider | 0.25 | High | `src/lib/csv.ts` already reads arbitrary shapes |
| Extended `db:verify` | 0.25 | High | Asserts the new constraints in the live database |
| Synthetic corpus v1 | 0.5 | Medium | The asset every later phase is measured against |

**Exit:** a CSV of mixed-quality people becomes deduplicated person records with full provenance
and a lifecycle, and `db:verify` proves the guarantees in the real database.

---

## Phase 2 — Signals and scoring *(3–4 weeks, confidence: medium)*

The product's actual value.

| Module | Weeks | Confidence | Notes |
| --- | --- | --- | --- |
| Signal taxonomy + deterministic detectors | 1.0 | Medium | Precision on negatives is the hard part, not recall |
| Decay + intent scoring | 0.5 | High | Tier-anchored per `SCORING.md` §3 |
| Client-fit engine | 0.75 | High | Generalises the existing `icp.ts` rule shape |
| Contactability + freshness | 0.25 | High | |
| Final score, gates, banding | 0.5 | Medium | Percentile calibration needs real distribution |
| Explanation record + rendering | 0.5 | High | |
| Scoring profiles (versioned, immutable) | 0.5 | High | |
| Corpus regression harness (precision/recall) | 0.5 | Medium | Ships *with* scoring, never after |

**Exit:** every person carries an explainable score; a scoring change reports its precision/recall
delta before it ships.

**Risk:** detector precision against real messy text. Budget for two tuning iterations, and expect
`RECENTLY_STARTED_ROLE` to be the one that costs the most.

---

## Phase 3 — Pipeline runner and scheduling *(2–3 weeks, confidence: medium)*

| Module | Weeks | Confidence |
| --- | --- | --- |
| Stage runner, per-record flow, retries | 1.0 | Medium |
| `pg-boss` queue + advisory-lock single-writer | 0.5 | High |
| Scheduler (daily/hourly/per-campaign/manual/pause) | 0.75 | High |
| Run records, counters, degraded-run semantics | 0.5 | High |

**Exit:** a scheduled run processes a batch end to end, survives a mid-run kill, and reports
honestly when a stage fails.

---

## Phase 4 — Discovery providers *(2–4 weeks, confidence: LOW — depends entirely on Phase 0)*

| Provider | Weeks | Confidence |
| --- | --- | --- |
| Orchestrator (budgets, rate limits, health, circuit breaking) | 1.0 | Medium |
| WARN public records | 0.75 | Low — filing formats vary by state, several are PDFs |
| Hacker News | 0.25 | High — clean public API |
| Licensed vendor #1 | 1.0 | Low — contract, coverage and match rate are unknowns |
| GitHub / Reddit / Bluesky | 0.75 | Medium |

**The WARN × vendor join is the piece to prototype first** (`DISCOVERY.md` §3) — it is the most
defensible route to volume, and if it does not work the target needs revisiting immediately.

---

## Phase 5 — Enrichment and verification *(2 weeks, confidence: low)*

Enrichment behind a provider interface; email verification behind another; spend caps; provenance
on every enriched field; contactability rescoring. Confidence is low because match rates and
cost-per-record are vendor realities, not design choices — both must be measured in a trial before
they are relied on.

---

## Phase 6 — Dashboard *(3 weeks, confidence: high)*

Daily metrics, campaign views, lead table with the full filter set, lead detail showing signals and
score explanation, merge review queue, provider health, run history, scoring-profile editor.

Straightforward — the shadcn/ui component vocabulary and table/filter/pagination patterns already
exist in this repository.

---

## Phase 7 — Export and integration *(1.5 weeks, confidence: high)*

CSV, JSON, REST with scoped tokens, webhooks, and promotion of qualified leads into the existing
outreach platform via `person.linkedin_url` → `leads.linkedinUrl`. No coupling to any single
outreach vendor.

---

## Phase 8 — AI adjudication *(1.5–2 weeks, confidence: medium)*

Deliberately last. The deterministic detectors must be good first, or the model is being used to
paper over a weak taxonomy — and you will not be able to tell which is which.

Strict JSON schema, nullable fields, content-hash caching, spend caps degrading to rules-only,
`ai_inference` provenance, and the hard rule that no contact field may originate from a model.
Measure cost per qualified lead here, and the precision delta over rules alone on the corpus. If
the delta is small, that is a finding worth having — not every product needs this layer.

---

## Compliance track — runs alongside, gates launch

Not a phase, because it cannot be done at the end. The legitimate-interest assessment, privacy
notice, DSAR export, erasure path and region gating must land before any real outreach.
Checklist in [`SECURITY.md`](./SECURITY.md) §11.

---

## Totals

| Path | Weeks |
| --- | --- |
| Phase 0 spike | 2 |
| Core to a usable internal product (1–4, 6) | 13–18 |
| Full scope (1–8) | 18–24 |

Ranges are honest, not padded: Phases 4 and 5 carry genuine unknowns that Phase 0 exists to
collapse. Expect the total to move once the spike reports.

---

## What I would cut if the timeline halves

Ranked by value retained per week spent, on the assumption that a smaller, trustworthy system beats
a larger, unproven one:

1. **Keep:** identity, provenance, lifecycle, suppression, deterministic scoring, CSV import,
   a lead table with filters, CSV export. That is a working internal product fed by imports.
2. **Defer:** the AI layer entirely — measure whether rules alone are sufficient first.
3. **Defer:** enrichment and verification — use whatever contact data the source supplies, and gate
   `READY_FOR_OUTREACH` on it.
4. **Defer:** all providers except CSV import and one high-precision source.
5. **Never defer:** suppression, provenance, the erasure path. Retrofitting any of the three means
   invalidating data you have already collected.
