# Scoring Architecture

Status: **proposal, awaiting review.**

Contains two defects found while working through the brief's own numbers — a banding problem
(§5) and a double-counting problem (§4). Both are fixable, and both are much cheaper to fix now
than after the dashboard is built around them.

---

## 1. Principles

**Deterministic rules decide; AI only interprets.** A rule can be read, argued with, unit-tested,
and reproduced next year. A model call cannot. AI is confined to the genuinely ambiguous middle,
where semantic judgement adds something a regex cannot.

**A score is worthless without its reasons.** Every score carries the factors that produced it,
each pointing at the evidence row behind it. Without that you cannot tell a badly-calibrated rule
from a genuinely weak lead — and you will be tuning this constantly.

**Scores are derived, never authoritative.** Any score can be recomputed from stored inputs. This
is what makes rescoring after a weight change possible, and what makes an A/B of two scoring
versions over the same population possible.

**Rules are data.** Signal points, decay curve, weights and thresholds live in a `scoring_profile`
row. Changing the ICP is an edit, not a deploy.

---

## 2. Signal taxonomy

Signals are typed, tiered, and carry the verbatim text that triggered them.

### HIGH intent — explicit, first-person, current

| Type | Fires on (examples) |
| --- | --- |
| `ACTIVE_JOB_SEARCH` | "actively looking for", "actively seeking", "I'm job hunting" |
| `SEEKING_NEXT_ROLE` | "looking for my next role", "seeking my next opportunity" |
| `RECENT_LAYOFF` | "I was laid off", "my role was eliminated", "part of the recent layoffs" |
| `AVAILABLE_IMMEDIATELY` | "available immediately", "available to start right away" |
| `REFERRAL_REQUEST` | "would appreciate any referrals", "please keep me in mind" |
| `JOB_SEARCH_POST` | a post whose subject *is* their search |
| `OPEN_TO_WORK_EXPLICIT` | self-declared open-to-work status with a date |

### MEDIUM intent — real but softer, or undated

`OPEN_TO_OPPORTUNITIES` ("open to new opportunities"), `EXPLORING_OPTIONS`,
`CAREER_TRANSITION` ("pivoting into…"), `APPLICATION_DIFFICULTY` ("300 applications, no replies"),
`INTERVIEW_DIFFICULTY`.

The difficulty signals matter commercially: someone struggling to convert applications is
precisely who reverse-recruiting helps, and they announce it themselves.

### LOW intent — weak or stale

`GENERIC_NETWORKING`, `OLD_CAREER_POST`, `VAGUE_AVAILABILITY`, `PROFILE_KEYWORD_ONLY`
(a bio keyword with no date attached — undated evidence cannot be decayed honestly).

### NEGATIVE — evidence *against*, stored as evidence

| Type | Effect |
| --- | --- |
| `RECENTLY_STARTED_ROLE` | **Hard gate** when < 90 days and confidence high |
| `PROMOTION_ANNOUNCEMENT` | Hard gate when recent |
| `CURRENTLY_HIRING` | Hard gate — they are the other side of the market |
| `RECRUITER_OR_STAFFING` | Hard gate |
| `COMPANY_REPRESENTATIVE` | Strong negative |
| `SALES_CONTENT` | Strong negative |

> `RECENTLY_STARTED_ROLE` is the most dangerous false positive in the whole system. "Excited to
> announce the next chapter in my career" pattern-matches to job-search language while meaning the
> exact opposite. It must be tested explicitly in the synthetic corpus, in both directions.

Negative signals are **hard gates, not just negative points**. Someone who started a job last week
is not a weak lead, they are not a lead. Points would let a strong positive stack over the top.

---

## 3. Intent score — a correction to the brief's scale

The brief proposes additive points: explicit search +30, next-role +25, layoff +20, post +15,
availability +10.

**Worked example.** A person posts "I was laid off on Friday and I'm actively looking for senior
product roles" three days ago. That is one clear, explicit, fresh statement. Under the additive
scale it earns roughly `30 + 20 = 50` before decay. Fifty out of a hundred — for the single
strongest signal this system will ever see. Everything downstream inherits that compression: with
the 50/30/10/10 weights, this person lands in the **LOW** band. (§5 works the arithmetic through.)

The cause is that an additive scale needs *five different* signal types to approach 100, but real
people usually emit one or two. The scale is measuring verbosity, not intent.

**Recommended instead — tier-anchored with corroboration:**

```
base       = strongest signal's tier anchor      HIGH 85 | MEDIUM 55 | LOW 25
corroboration = +5 per additional independent signal, capped at +15
                (independent = different signal_type AND different source)
raw        = min(100, base + corroboration)
intent     = round(raw × decay(strongest signal's published_at))
```

The same person now scores `85 + 5 = 90`, decayed at three days (×0.90) → **81**. That is a number
that behaves the way the words on the page do.

Corroboration is capped and requires *independent* sources, so a single post syndicated to four
platforms does not manufacture confidence.

If no signal carries a `published_at`, decay cannot be applied honestly: the signal is demoted to
LOW tier and a confidence penalty is recorded. Undated evidence is never treated as fresh.

---

## 4. Freshness — and a double-count to avoid

Decay curve, configurable per campaign, defaulting to the brief's values:

| Age of signal | Multiplier |
| --- | --- |
| 0–1 days | 1.00 |
| 2–3 days | 0.90 |
| 4–7 days | 0.75 |
| 8–14 days | 0.55 |
| 15–30 days | 0.30 |
| 31–60 days | 0.10 |
| 60+ days | 0.00 |

Stored as `decay_curve` jsonb, interpolated between points, never hardcoded.

**The double-count.** The brief applies decay inside the intent score *and* gives freshness its own
10% weight in the final formula. Signal age would then be counted twice, and the two uses would
drift apart under tuning — raising the freshness weight would silently amplify a decay that has
already been applied.

**Recommendation:** keep decay inside intent (that is where it belongs — a stale signal is weaker
evidence), and redefine the standalone `freshness_score` to measure **data freshness** instead:
how recently the *record* was seen and verified, independent of the signal's age.

```
freshness_score = f(days since last_seen_at, days since contact verified_at, enrichment age)
```

This is a distinct and genuinely useful property — it catches a stale record whose signal happens
to be recent — and it removes the overlap.

---

## 5. The banding defect

The brief specifies weights (intent 50, fit 30, freshness 10, contactability 10) and fixed bands
(HOT 90–100, HIGH 80–89, MEDIUM 70–79, LOW 60–69, REJECT < 60).

Take the strongest realistic lead this system can produce: explicit layoff plus active search,
posted three days ago, excellent ICP fit, verified email, freshly seen.

Under the brief's additive intent scale:

```
intent 50 (from §3) × 0.90 decay = 45
fit 85 · freshness 100 · contactability 100

overall = 0.5(45) + 0.3(85) + 0.1(100) + 0.1(100)
        = 22.5 + 25.5 + 10 + 10
        = 68  ->  LOW
```

**The best lead in the system lands in the second-worst band.** With fixed thresholds, HOT would be
effectively unreachable and the operator would learn to ignore the bands within a week.

Two changes, together:

**(a) Fix the intent scale** (§3). Re-running the same lead with tier anchoring:

```
intent = 90 × 0.90 = 81
overall = 0.5(81) + 0.3(85) + 0.1(100) + 0.1(100) = 40.5 + 25.5 + 10 + 10 = 86  ->  HIGH
```

Reasonable: strong but not perfect fit, three days old.

**(b) Calibrate bands against the observed distribution rather than fixing them in advance.**
After a fortnight of real scores, set thresholds at percentiles of the actual population —
HOT = top 5%, HIGH = next 15%, MEDIUM = next 30%, LOW = next 25%, REJECT = bottom 25% — and store
them in the scoring profile. Fixed thresholds are the fallback until data exists, and remain
available for operators who prefer absolute scores.

Percentile bands make "HOT" mean *the best available today*, which is what a daily worklist needs.
They also self-correct when supply quality shifts. The distribution and the current cut-points
belong on the dashboard, so nobody has to guess what the bands currently mean.

---

## 6. Client-fit score

Generalises the rule engine already built in `src/lib/icp.ts` (rules as data, points, veto
patterns, reasons attached to every hit). Dimensions, each configurable and weighted within fit:

seniority · target role match · geography · likely salary band · industry ·
years of experience · career complexity (multiple pivots, visa needs, returning after a
break — these *raise* fit, since they are exactly what reverse-recruiting sells) ·
job-search difficulty · service compatibility.

Two deliberate departures from the naive version:

- **Career complexity is a positive.** A straightforward senior candidate in a hot market does not
  need this service. Someone changing industry after a layoff does. Fit measures suitability for
  the *offer*, not general employability.
- **Fit is per campaign.** The same person can be a great fit for one offer and a poor one for
  another, which is why `lead_score` is keyed by `(person_id, campaign_id)`.

---

## 7. Contactability, and why it is also a gate

```
100  verified deliverable personal email
 80  verified work email  (weaker: it dies with the job — often the very job they are leaving)
 60  catch-all or risky
 40  profile/handle only, no email
 20  name and company only
  0  nothing actionable
```

Note the ordering: for *this* product a work email is worth less than a personal one, because the
population is by definition leaving that employer.

**Also a gate.** At 10% weight, a lead with no contact route can still score in the high 80s and be
completely unworkable. Recommendation: keep the weight for ranking, and additionally require a
verified route before `READY_FOR_OUTREACH`. Ranking and actionability are different questions.

---

## 8. Final score and explanation

```
overall = w.intent×intent + w.fit×fit + w.freshness×freshness + w.contact×contactability
```

Gates run first and short-circuit: an active hard-negative signal, or a suppression match, produces
`REJECT` with the gate named, and no weighted score is computed.

Every score writes an explanation:

```json
{
  "scoreVersion": "intent-2.1+fit-1.4",
  "profileVersion": "reverse-recruiting-default@7",
  "band": "HIGH",
  "overall": 86,
  "components": {
    "intent": { "score": 81, "base": 85, "corroboration": 5, "decay": 0.9,
      "factors": [
        {"points": 85, "label": "Explicit active job search", "signalId": "sig_...",
         "quote": "actively looking for senior product roles", "publishedAt": "2026-08-26"},
        {"points": 5, "label": "Corroborated by layoff statement", "signalId": "sig_..."}
      ]},
    "clientFit": { "score": 85, "factors": [
      {"points": 30, "label": "Senior individual contributor"},
      {"points": 25, "label": "Target geography"},
      {"points": 20, "label": "Industry transition raises service value"}
    ]},
    "freshness": { "score": 100, "lastSeenDays": 0, "contactVerifiedDays": 1 },
    "contactability": { "score": 100, "route": "verified personal email" }
  },
  "negativeFactors": [],
  "gatesEvaluated": ["recently_started_role", "recruiter", "suppression"],
  "confidence": 0.86
}
```

Rendered in the UI as prose: *"Intent 81 — explicitly seeking senior product roles, posted 3 days
ago, corroborated by a layoff statement. Fit 85 — senior, in target geography, mid-career industry
transition. Verified personal email."*

---

## 9. The AI layer

**Permitted:** deciding whether ambiguous text indicates job-seeking intent; extracting the target
role from free text; classifying industry; summarising why a prospect is relevant; disambiguating
"open to opportunities" said by a recruiter versus a candidate.

**Forbidden, structurally:** inventing an employer, title, salary, email, date, or years of
experience. Enforced by three mechanisms rather than by prompt instruction alone:

1. Output is a strict JSON schema; every extractable field is nullable and *"return null if the
   text does not state it"* is the documented contract.
2. AI-derived values are written as `field_observation` rows with `source_kind = 'ai_inference'`,
   which loses to every human-sourced observation under the resolution policy (`DATABASE.md` §3).
3. **No contact field may ever originate from AI.** Emails and phone numbers come from a source or
   a verification vendor, never from a model. This is a hard rule in the write path, not a
   guideline.

Every AI-derived field stores `model`, `prompt_version`, `confidence`, `timestamp`.

**Cost is controlled by gating, not by hoping.** Deterministic detectors run first; the model is
called only for records that are ambiguous *and* have already passed a cheap fit pre-filter.
Everything is cached by content hash, so re-processing the same text costs nothing. Expected call
volume is a fraction of raw discovery, and **cost per qualified lead must be measured in Phase 2,
not assumed** — with a per-run spend cap that degrades to rules-only rather than overspending.

The provider sits behind `AiAdjudicator`, one interface, swappable, with a rules-only
implementation used in tests so the suite never makes a network call.

---

## 10. Versioning and rescoring

`score_version` covers the rule logic; `profile_version` covers the weights and thresholds. Both
are recorded on every score row, and profiles are immutable once used — editing creates a new
version, so a historical score stays reproducible.

A nightly job rescores active leads, because decay makes yesterday's score wrong by morning.
Scoring is pure and local, so this is cheap.

Before a scoring change ships, it is replayed over the synthetic corpus **and** the last 30 days of
real records, and the diff is reported as precision/recall and band-migration counts. A change that
improves recall while quietly destroying precision must be visible as a number before it lands, not
after the operator notices the list got worse.
