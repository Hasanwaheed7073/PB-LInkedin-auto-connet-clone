# Security, Privacy and Compliance

Status: **proposal, awaiting review.**

This system's entire purpose is to build dossiers on people who are, by definition, in a vulnerable
moment: recently laid off, struggling to find work, financially exposed. None of them asked to be
in the database. That framing should drive the controls below more than any compliance checklist
does.

**This document is not legal advice.** Sections 4–6 identify obligations that need a qualified
opinion for the jurisdictions you actually operate in. They are flagged, not resolved.

---

## 1. What will not be built

Stated first because it is the boundary that constrains the design, and because deadline pressure
erodes boundaries that are only implied.

- No automated authenticated access to any platform that forbids it, and no reuse of harvested
  session cookies.
- No CAPTCHA solving, bot-detection evasion, fingerprint spoofing, or proxy rotation intended to
  appear as multiple users.
- No rate-limit circumvention. Limits are respected as stated, including `robots.txt` and terms
  covering automated access.
- No credential storage for third-party consumer accounts.
- No purchase or use of datasets whose provenance cannot be established.

The `ComplianceDeclaration` required on every discovery provider (`DISCOVERY.md` §1) is the
mechanism that keeps this enforceable: a source that cannot state its lawful basis cannot be
registered, so the boundary is checked by the type system and by review, not by memory.

---

## 2. Secrets

- Environment variables only; nothing in the repository. `.gitignore` already covers `.env*`, and
  `*.csv` was added after lead lists were found untracked in the working tree.
- Validated at boot by a Zod schema (`src/lib/env.ts` pattern), with placeholder values explicitly
  rejected so a half-configured deployment fails loudly rather than running degraded.
- Separate credentials per environment. Production secrets are never used locally.
- Vendor API keys are held only by the pipeline runner. The dashboard never sees them.
- Rotation runbook, and rotation on any suspected exposure — including a key pasted into a chat,
  ticket, or terminal transcript.

---

## 3. Access control

**Dashboard** — session cookies, the existing `src/lib/auth.ts` pattern. Roles: `OPERATOR`
(read plus lead actions), `ADMIN` (scoring profiles, providers, exports, suppression). Every
mutation writes an audit row.

**API** — bearer tokens, one per consumer, scoped and independently revocable, with per-token rate
limits. Export endpoints are the most sensitive surface in the system: a single call can exfiltrate
the entire dossier set. Treat export as a privileged action, log every call with the row count and
filter used, and cap page sizes.

**Pipeline runner** — holds database credentials and vendor keys; runs on infrastructure you
control, not on a shared host.

**Database** — least-privilege roles; the dashboard role cannot write to append-only tables (the
triggers enforce this regardless).

---

## 4. Lawful basis — the part that needs a lawyer

GDPR/UK GDPR applies to EU and UK data subjects **regardless of where the data was found or where
you are based**. "It was publicly available" is not, by itself, a lawful basis for processing.

Realistically the basis is **legitimate interest** (Art. 6(1)(f)), which requires a documented
three-part balancing test — purpose, necessity, and the data subject's rights and expectations —
retained as evidence. That assessment must be written before EU/UK subjects are processed, not
after.

Specific obligations that carry engineering work:

| Obligation | Engineering consequence |
| --- | --- |
| Art. 14 — notice when data is *not* collected from the subject | A privacy notice must reach them, generally within a month or at first contact. This shapes the outreach template, not just the website |
| Art. 15 — right of access | Export everything held about one person, including signals and provenance. The `field_observation` model makes this a query rather than an archaeology project |
| Art. 17 — erasure | Delete, and **suppress**, so re-discovery does not resurrect them |
| Art. 21 — objection | Immediate stop, permanently |
| Art. 22 / profiling | This system *is* automated profiling. Explainability is a compliance asset, not only a product feature — `lead_score.explanation` is the artifact that answers "why was I scored this way?" |
| Storage limitation | Retention policy with automatic expiry (§6) |

US: CCPA/CPRA give California residents deletion and opt-out rights; several other states now
mirror this. CAN-SPAM governs the email itself, not the collection.

**Recommendation:** do not process EU/UK subjects until the legitimate-interest assessment exists
and the erasure path works end to end. Region-gate at the discovery orchestrator — a
`target_locations` filter is not a compliance control, an explicit gate is.

---

## 5. Suppression and Do Not Contact

The single most important control in the system, because it is the one a real person will exercise
against you.

- `suppression` is keyed by identity key (`LINKEDIN_URL`, `EMAIL`, `HANDLE`, …) and checked at
  **identity resolution**, before scoring, before enrichment, before any spend.
- Suppression survives deletion of the person record. A hash of the identity key is retained
  specifically so a deleted person cannot be silently re-acquired from another source — retaining
  the minimum necessary to honour their objection is itself the lawful thing to do.
- `DO_NOT_CONTACT` is terminal and absorbing, enforced by a database constraint (`DATABASE.md` §8),
  not by application code that a refactor could remove.
- Every unsubscribe, objection, complaint, or bounce-to-complaint writes a suppression row
  automatically. Manual entry is available to `ADMIN` and audited.

Suppression must be **testable**: an integration test that suppresses a person, re-runs discovery
from a second source, and asserts they do not reappear.

---

## 6. Data minimisation and retention

Collect only what scoring, contactability, or provenance actually requires. Notably **do not**
collect or infer: date of birth, photographs, ethnicity, health, religion, political views, sexual
orientation, union membership, or immigration status. Several are special-category data under
Art. 9 with a far higher bar, and none improve the score.

Watch the adjacent hazards: "career break" and "returning to work" often encode caring
responsibilities, disability, or parental leave. Treat inferred career-break reasons as
special-category-adjacent and do not store a reason — the fact of a gap is sufficient for scoring.

Retention defaults, configurable and enforced by a scheduled job that reports what it deleted:

| Data | Default |
| --- | --- |
| Raw discovery payloads | 90 days |
| Rejected candidates | 180 days, then identity-key hash only |
| Signals for active leads | 24 months |
| Contact points | Deleted on erasure or 24 months without engagement |
| Converted customers | Per the customer contract, not this policy |
| Audit and suppression | 7 years |

Vendor-supplied records inherit the shorter of our retention and the vendor contract's
(`ComplianceDeclaration.retentionDays` carries this).

---

## 7. Audit

Append-only, trigger-enforced, matching the existing `activity_logs` pattern: every score, every
lifecycle transition, every merge, every export, every suppression, every scoring-profile change,
every provider enable/disable, every admin login.

Merges and exports deserve particular attention — a merge silently rewrites who a record refers to,
and an export moves personal data out of the system's controls.

---

## 8. Encryption and infrastructure

TLS everywhere; encryption at rest via the managed database. Application-level encryption for
contact values is worth considering but is not a substitute for access control — the dashboard
must decrypt to display, so it protects against backup theft, not against a compromised session.

Backups are as sensitive as the database and must honour erasure: document the process for
propagating a deletion into backups, or accept and record a bounded window in which it has not
propagated.

---

## 9. Rate limiting and abuse

Per-token API limits; per-IP limits on login with lockout and audit; per-provider outbound limits
in the orchestrator (a runaway loop against a vendor is both a cost incident and a terms breach);
a per-run spend cap on AI and enrichment that degrades to rules-only rather than overspending.

---

## 10. Incident response

Personal data on hundreds to thousands of people means a breach is notifiable — 72 hours under
GDPR. Before go-live: a named owner, a documented containment and rotation procedure, an assessment
template, and a rehearsal. The `field_observation` and audit tables make "what exactly was exposed"
answerable, which is the question that otherwise consumes the first day of an incident.

---

## 11. Pre-launch checklist

- [ ] Legitimate-interest assessment written and reviewed by counsel
- [ ] Privacy notice published; Art. 14 notification path built into outreach
- [ ] DSAR export and erasure implemented **and tested end to end**
- [ ] Suppression proven to survive re-discovery (integration test)
- [ ] Region gating decided and enforced at the orchestrator
- [ ] Retention job running and reporting
- [ ] Every provider carries a reviewed `ComplianceDeclaration`
- [ ] Vendor contracts reviewed for onward-processing rights
- [ ] Export endpoints rate-limited, capped and audited
- [ ] Secrets rotated; no credential in any transcript or repository
- [ ] Incident runbook written and rehearsed
