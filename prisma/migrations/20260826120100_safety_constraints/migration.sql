-- Safety and integrity constraints that Prisma's schema language cannot express.
--
-- These are the load-bearing guarantees of the whole system. They are enforced by
-- PostgreSQL, so they hold even if every line of application code is wrong.
--
-- Note on identifiers: table names are mapped to snake_case via @@map, but column
-- names are Prisma defaults (camelCase) and are therefore case-sensitive and must
-- stay double-quoted.

-- ---------------------------------------------------------------------------
-- 1. Duplicate protection (requirement 16)
-- ---------------------------------------------------------------------------

-- At most ONE live job per (lead, action). Makes it impossible for two jobs
-- targeting the same person to be waiting or in flight at the same time, which
-- is what would otherwise let two invitations go out.
CREATE UNIQUE INDEX IF NOT EXISTS "queue_jobs_one_live_per_lead_action"
  ON "queue_jobs" ("leadId", "action")
  WHERE "status" IN ('WAITING', 'PROCESSING');

-- At most ONE resolved job per (lead, action), for all time. Once a CONNECT has
-- been resolved for a lead - whether it was SENT, or found ALREADY_CONNECTED or
-- ALREADY_PENDING - a second COMPLETED row cannot be written. This is the final
-- backstop against a duplicate invitation.
CREATE UNIQUE INDEX IF NOT EXISTS "queue_jobs_one_completed_per_lead_action"
  ON "queue_jobs" ("leadId", "action")
  WHERE "status" = 'COMPLETED';

-- Case-insensitive uniqueness on the canonical profile URL. `leads.linkedinUrl`
-- is already unique, and the normaliser lower-cases the slug, so this is a
-- belt-and-braces guard against a row inserted by hand or by a future code path
-- that skips normalisation.
CREATE UNIQUE INDEX IF NOT EXISTS "leads_linkedin_url_lower_unique"
  ON "leads" (LOWER("linkedinUrl"));

-- Supports the "has this lead already been contacted?" check on every claim.
CREATE INDEX IF NOT EXISTS "leads_invitation_sent_at_idx"
  ON "leads" ("invitationSentAt")
  WHERE "invitationSentAt" IS NOT NULL;

-- Partial index for the hot claim path: only WAITING rows are ever scanned.
CREATE INDEX IF NOT EXISTS "queue_jobs_claimable_idx"
  ON "queue_jobs" ("campaignId", "priority", "scheduledFor")
  WHERE "status" = 'WAITING';

-- Supports the reaper that recovers jobs abandoned by a dead worker.
CREATE INDEX IF NOT EXISTS "queue_jobs_expired_claims_idx"
  ON "queue_jobs" ("claimExpiresAt")
  WHERE "status" = 'PROCESSING';

-- Daily-limit counting reads only outreach actions from the activity log.
CREATE INDEX IF NOT EXISTS "activity_logs_outreach_counting_idx"
  ON "activity_logs" ("createdAt", "campaignId")
  WHERE "action" IN ('CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT');

-- Fast lookup of the incidents that hold the worker gate shut.
CREATE INDEX IF NOT EXISTS "incidents_blocking_open_idx"
  ON "incidents" ("createdAt")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED') AND "blocksWorker" = TRUE;

-- ---------------------------------------------------------------------------
-- 2. Immutable activity log (requirement 14)
-- ---------------------------------------------------------------------------

-- The activity log is the audit trail. Enforce append-only in the database so a
-- buggy or malicious UPDATE/DELETE fails loudly instead of rewriting history.
CREATE OR REPLACE FUNCTION "reject_activity_log_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'activity_logs is append-only: % is not permitted (row id %)',
    TG_OP,
    COALESCE(OLD."id", '(unknown)')
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "activity_logs_append_only" ON "activity_logs";
CREATE TRIGGER "activity_logs_append_only"
  BEFORE UPDATE OR DELETE ON "activity_logs"
  FOR EACH ROW EXECUTE FUNCTION "reject_activity_log_mutation"();

-- ---------------------------------------------------------------------------
-- 3. Single-row system state
-- ---------------------------------------------------------------------------

-- The kill switch lives in one row. A second row would create two conflicting
-- sources of truth about whether automation is allowed to run.
ALTER TABLE "system_state"
  DROP CONSTRAINT IF EXISTS "system_state_singleton";
ALTER TABLE "system_state"
  ADD CONSTRAINT "system_state_singleton" CHECK ("id" = 'singleton');

-- ---------------------------------------------------------------------------
-- 4. Sanity constraints on scheduling configuration
-- ---------------------------------------------------------------------------

ALTER TABLE "campaign_settings"
  DROP CONSTRAINT IF EXISTS "campaign_settings_sane_window";
ALTER TABLE "campaign_settings"
  ADD CONSTRAINT "campaign_settings_sane_window" CHECK (
    "windowStartMinute" BETWEEN 0 AND 1440
    AND "windowEndMinute" BETWEEN 0 AND 1440
    AND "windowStartMinute" <> "windowEndMinute"
  );

ALTER TABLE "campaign_settings"
  DROP CONSTRAINT IF EXISTS "campaign_settings_sane_delays";
ALTER TABLE "campaign_settings"
  ADD CONSTRAINT "campaign_settings_sane_delays" CHECK (
    "minActionDelaySeconds" > 0
    AND "maxActionDelaySeconds" >= "minActionDelaySeconds"
  );

-- A daily limit is a safety control; refuse a nonsensical value at the storage
-- layer as well as in the Zod schema.
ALTER TABLE "campaign_settings"
  DROP CONSTRAINT IF EXISTS "campaign_settings_sane_daily_limit";
ALTER TABLE "campaign_settings"
  ADD CONSTRAINT "campaign_settings_sane_daily_limit" CHECK (
    "dailyLimit" > 0 AND "dailyLimit" <= 100
  );

ALTER TABLE "queue_jobs"
  DROP CONSTRAINT IF EXISTS "queue_jobs_sane_attempts";
ALTER TABLE "queue_jobs"
  ADD CONSTRAINT "queue_jobs_sane_attempts" CHECK (
    "attempts" >= 0 AND "maxAttempts" >= 1
  );
