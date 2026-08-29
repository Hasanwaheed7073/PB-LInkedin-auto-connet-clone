# ADR-0003 — Relationship to the existing outreach platform

- **Status:** Proposed
- **Date:** 2026-08-29

## Context

This repository holds a working LinkedIn outreach operations platform: campaigns, a scheduled
queue, a supervised browser worker, incident handling, an emergency stop, and a duplicate-invitation
guarantee enforced by four independent database-level mechanisms.

The new engine finds and qualifies people. The existing platform contacts them. The question is
whether they are one system, two systems in one repository, or two repositories.

## Decision

**One repository, one database, two bounded contexts, connected by a narrow promotion step.**

- The engine owns `person`, signals, observations, scores, discovery and lifecycle.
- The outreach platform continues to own `leads`, `campaigns`, `queue_jobs`, `incidents` and the
  worker, unchanged.
- The join is `person.linkedin_url` → `leads.linkedinUrl`, both already canonicalised by the same
  tested normaliser.
- **Promotion is explicit and operator-driven.** A qualified lead does not flow automatically into
  an outreach queue.

## Rationale

**Shared identity is the whole point.** Both halves identify people by canonical profile URL. One
database means the engine can see that a person is already a lead, already contacted, or already
suppressed — without a synchronisation job that will drift.

**Separate tables keep the safety architecture intact.** The outreach platform's duplicate
protection depends on `leads.linkedinUrl` being globally unique — one row per person, ever. If
discovery wrote directly into `leads`, then every speculative candidate would consume that global
uniqueness, and the table would stop meaning "someone we intend to contact". The engine's
`person` table can hold a million rejected candidates without touching that guarantee.

**Manual promotion is a safety property, not friction.** Automatic promotion would let a scoring
bug enqueue real invitations to real people at machine speed. The existing platform is built around
the principle that contact is deliberate — pre-flight checks, an explicit activation path,
confirmation dialogs that spell out what is about to happen. Automated promotion would route around
all of it. The operator reviews a ranked list and promotes; the daily ceiling still governs
everything downstream.

**Repository-level split buys nothing here.** Shared code (identity, CSV, scoring rules), shared
migrations, one CI run, one deployment. A second repository would need the shared code published as
a package and versioned across two release cycles, for a team where that coordination cost is pure
overhead.

## Consequences

- Migrations are additive; no existing table is modified.
- `npm run db:verify` extends to cover the new constraints, keeping one command that proves the
  system's guarantees against the live database.
- The engine can read outreach state (contacted, replied, suppressed) directly when scoring —
  a lead already in an active campaign should not resurface at the top of tomorrow's list.
- If the engine is later sold or operated separately, the extraction seam is the promotion step and
  the shared `linkedin_url` key, both of which are narrow by construction.

## Explicitly out of scope

The engine does not contact anyone, does not open a browser, and does not write to `queue_jobs`.
Every outbound action continues to go through the existing platform's controls, including the
emergency stop and the daily ceiling.
