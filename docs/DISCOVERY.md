# Discovery Architecture

Status: **proposal, awaiting review.**

This document contains the finding most likely to change the shape of the project, so it is first:
**the daily target of 500–600 qualified leads is a supply problem, not a processing problem, and
the supply may not exist at that volume from lawful sources without paid data or an owned funnel.**
Section 3 sets out the numbers. Section 6 proposes a two-week spike to replace those estimates with
measurements before any pipeline is built on top of them.

---

## 1. The provider abstraction

The rest of the application must never know where a candidate came from. One interface, one
registration point, one file per source, no cross-imports between providers.

```ts
/** A source's declared, auditable basis for use. Required — not documentation. */
interface ComplianceDeclaration {
  basis: 'public_api_tos' | 'public_record' | 'licensed_contract' | 'user_submitted';
  /** Link to the ToS, licence, or statutory publication that permits this. */
  reference: string;
  /** Does the source permit storing the retrieved data, and for how long? */
  retentionDays: number | null;
  /** Set when the source imposes obligations we must honour downstream. */
  restrictions: string[];
  reviewedAt: string;
  reviewedBy: string;
}

interface DiscoveryProvider {
  readonly id: string;
  readonly kind: 'public_web' | 'public_record' | 'licensed_vendor' | 'import' | 'owned';
  readonly compliance: ComplianceDeclaration;

  /** Cheap liveness + quota check. Feeds provider health on the dashboard. */
  health(): Promise<ProviderHealth>;

  /** Streams raw records. Must respect `budget` and stop cleanly when exhausted. */
  search(criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord>;

  /** Pure. Raw payload -> canonical candidate, or an explicit failure with a reason. */
  normalize(raw: RawRecord): NormalizedCandidate | NormalizationFailure;
}

interface Budget {
  maxRecords: number;
  maxRequests: number;
  maxSpendUsd: number;      // licensed vendors bill per record
  deadline: Date;
}
```

Rules that make the abstraction real rather than decorative:

- **No downstream code may branch on `provider.id`.** Enforced by review and by the fact that
  nothing after `normalize` receives it except as provenance metadata.
- **`normalize` is pure and separately testable** against recorded fixtures. Provider tests need no
  network.
- **A provider that cannot fill in `compliance` cannot be registered.** This is the mechanism that
  keeps "just scrape it" from creeping in later under deadline pressure.
- **Failure is explicit.** `NormalizationFailure` carries a reason and the record is stored as a
  rejection. Nothing is silently dropped.
- **Budgets are enforced by the orchestrator, not trusted to the provider.**

### Orchestrator responsibilities

Per-provider concurrency and rate limits (a slow vendor must not starve fast sources), budget
enforcement, retry with backoff on transient failure, circuit-breaking a provider that is failing
and marking the run **degraded** rather than silently short, and writing `discovery_record` rows
with `UNIQUE (provider_id, external_id)` so re-running a discovery window is idempotent.

---

## 2. What "lawful source" excludes

Stated plainly because it constrains everything downstream. The system will not:

- Log into LinkedIn programmatically, reuse a harvested session cookie, or drive an authenticated
  session to read profiles at scale.
- Bypass CAPTCHAs, rate limits, bot detection, or access controls anywhere.
- Rotate proxies or spoof fingerprints to appear as many users.
- Ignore `robots.txt` or a site's stated automated-access terms.

This is not only a legal position, it is a product one: this repository already runs a supervised
outreach worker on a real LinkedIn account. A scraper attached to the same operation risks the
account the outreach depends on. The two cannot coexist safely.

---

## 3. Source inventory and realistic yield

Yields below are **estimates from source characteristics, not measurements.** They are the input to
the Phase 0 spike, not a substitute for it. Where I am uncertain about a source's current terms or
availability, it is marked `[UNCONFIRMED]` and must be verified before any build.

Definitions: *credible* = carries dated, attributable job-seeking evidence. *Contactable* = a route
to reach them exists or can plausibly be enriched.

| Source | Kind | Intent quality | Est. credible/day | Contactable share | Confidence |
| --- | --- | --- | --- | --- | --- |
| **HN "Who wants to be hired?"** monthly thread | public_web | **Very high** — explicit, self-declared | 10–20 (as a monthly batch amortised) | High — most include email | Medium |
| **Public WARN layoff notices** (US state filings) | public_record | **High**, but *company-level* | Company events, not people | n/a directly | Medium |
| **GitHub** profile/bio "open to work" | public_web | Medium — often stale | 20–60 | Medium — email sometimes public | Low |
| **Reddit** (r/jobs, r/resumes, r/layoffs) | public_web | High intent, **weak identity** | 100–300 posts | **Very low** — pseudonymous | Medium |
| **Bluesky / Mastodon** public posts | public_web | Medium | 5–30 | Low–medium | Low |
| **X/Twitter** API | public_web | Medium | volume ∝ spend | Low | Low `[UNCONFIRMED cost]` |
| **Licensed people-data vendors** | licensed_vendor | **Low intent, high volume** — they know jobs and dates, rarely intent | effectively unbounded | High | Medium |
| **Owned funnel** (your content, lead magnets, opt-ins) | owned | **Highest** — they came to you | ∝ marketing spend | Highest | High |
| **Outplacement / career-service partnerships** | owned | **Highest** — consented, in-market | ∝ partnerships | Highest | High |
| **CSV / dataset import** | import | Varies | operator-supplied | Varies | High |

### The two findings that matter

**Finding 1 — public web supplies tens per day, not hundreds.** Summing the credible-and-contactable
column optimistically lands somewhere around **40–120/day**, dominated by sources whose contactable
share is poor. Reddit looks like the largest number in the table and is nearly useless on its own:
high intent, but a pseudonymous handle is not a person you can reverse-recruit for.

**Finding 2 — the highest-leverage source is a join, not a scrape.** WARN notices are statutory,
published by state labour departments, fully public, and legally clean. They give *company + date +
number affected*. They do not give people. But joined against a licensed people-data vendor
("who worked at Acme Manufacturing as of last month"), they yield a large population with a
**dated, documented, high-confidence redundancy signal** and vendor-supplied contact data.

That join is, in my view, the most defensible route to volume in this entire design: the intent
signal comes from a public record rather than an inference, and the contact data comes from a
vendor under contract. It is worth prototyping first.

### The honest conclusion

Reaching 500–600 *qualified* leads per day requires at least one of:

- **a licensed data budget** (volume with weak intent, rescued by the WARN join),
- **an owned inbound funnel** (best quality, slowest to build, scales with marketing spend),
- **partnership channels** (outplacement firms, career services — consented and in-market),

or the target is revised downward. Public-web discovery alone will not get there, and building a
600/day pipeline over a 60/day supply is the most expensive available mistake.

I would rather say this now, in a document you can disagree with, than discover it in month three.

---

## 4. Provider implementation order

1. `import` — CSV/dataset. Reuses `src/lib/csv.ts` (shape-agnostic reading already built). Zero
   external risk and it makes the whole downstream pipeline testable on day one.
2. `warn_notices` — public record, high value, no ToS ambiguity.
3. `hacker_news` — public API, explicit intent, excellent precision test case.
4. `licensed_vendor` — behind the same interface; the WARN join partner.
5. `github`, `reddit`, `bluesky` — lower yield, useful for taxonomy breadth and for testing the
   negative-signal detectors against messy real text.
6. `owned` — webhook/API intake from your own funnel and partnerships.

---

## 5. Normalisation contract

```ts
interface NormalizedCandidate {
  identity: { linkedinUrl?: string; email?: string; handles?: {platform: string; handle: string}[];
              fullName?: string; company?: string; companyDomain?: string };
  attributes: FieldObservation[];   // every one carries source, url, observedAt, confidence
  signals: RawSignalEvidence[];     // verbatim text + publishedAt + url. NOT yet classified.
  provenance: { providerId: string; externalId: string; retrievedAt: Date; sourceUrl: string };
}
```

Two boundaries worth stating explicitly:

- **Providers do not classify.** A provider reports "this text was published at this URL on this
  date". Deciding whether it indicates job-seeking intent is the signal engine's job, centrally,
  so classification is consistent across sources and improves in one place.
- **Providers do not invent.** A field the source did not supply is absent, never inferred to a
  default. `NormalizationFailure` is the correct output for an unusable record.

---

## 6. Phase 0 — the discovery spike (recommended before Phase 2)

Two weeks, throwaway scripts, no pipeline, no schema. The single question: **what is the real
daily yield of credible, contactable, in-ICP job-seekers per source?**

Method: run each candidate source manually for ten working days. For each, record raw records
retrieved, how many carried dated job-seeking evidence, how many were contactable, how many matched
a plausible ICP, and cost per qualified record. Hand-label a 200-record sample per source to get an
honest precision figure rather than a hopeful one.

Deliverable: this document's table, with measurements replacing estimates, and a decision on the
daily target that the architecture is then built to serve.

Cost of the spike: roughly two weeks of one engineer plus small vendor trial credits. Cost of
skipping it: building a system sized for an order of magnitude more supply than exists, and finding
out after the schema, the scheduler, and the dashboard are all shaped around it.
