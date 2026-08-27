-- Refine the append-only guard on activity_logs.
--
-- The original trigger rejected every UPDATE. That was too strict in one specific
-- way: `activity_logs` has `ON DELETE SET NULL` foreign keys to leads, campaigns,
-- queue_jobs and workers, and PostgreSQL implements SET NULL as an UPDATE. So
-- deleting a lead that had any activity failed with the append-only exception,
-- which meant an uncontacted lead could not be removed at all.
--
-- Both properties are worth keeping:
--   * the CONTENT of an audit record must never change, and records must never be
--     deleted; and
--   * an audit record must outlive whatever it refers to.
--
-- So the trigger now permits exactly one shape of UPDATE: every content column
-- byte-identical, and each foreign-key column either unchanged or set to NULL.
-- Anything else - editing a message, changing a result, re-pointing a record at a
-- different lead - is still rejected.

CREATE OR REPLACE FUNCTION "reject_activity_log_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'activity_logs is append-only: DELETE is not permitted (row id %)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Permit only the foreign-key nulling that ON DELETE SET NULL performs.
  IF NEW."id"             IS NOT DISTINCT FROM OLD."id"
     AND NEW."createdAt"      IS NOT DISTINCT FROM OLD."createdAt"
     AND NEW."action"         IS NOT DISTINCT FROM OLD."action"
     AND NEW."result"         IS NOT DISTINCT FROM OLD."result"
     AND NEW."actorType"      IS NOT DISTINCT FROM OLD."actorType"
     AND NEW."actorId"        IS NOT DISTINCT FROM OLD."actorId"
     AND NEW."actorName"      IS NOT DISTINCT FROM OLD."actorName"
     AND NEW."incidentId"     IS NOT DISTINCT FROM OLD."incidentId"
     AND NEW."message"        IS NOT DISTINCT FROM OLD."message"
     AND NEW."error"          IS NOT DISTINCT FROM OLD."error"
     AND NEW."pageState"      IS NOT DISTINCT FROM OLD."pageState"
     AND NEW."screenshotPath" IS NOT DISTINCT FROM OLD."screenshotPath"
     AND NEW."durationMs"     IS NOT DISTINCT FROM OLD."durationMs"
     AND NEW."metadata"       IS NOT DISTINCT FROM OLD."metadata"
     -- Each FK may only stay the same or become NULL.
     AND (NEW."leadId"     IS NULL OR NEW."leadId"     IS NOT DISTINCT FROM OLD."leadId")
     AND (NEW."campaignId" IS NULL OR NEW."campaignId" IS NOT DISTINCT FROM OLD."campaignId")
     AND (NEW."queueJobId" IS NULL OR NEW."queueJobId" IS NOT DISTINCT FROM OLD."queueJobId")
     AND (NEW."workerId"   IS NULL OR NEW."workerId"   IS NOT DISTINCT FROM OLD."workerId")
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'activity_logs is append-only: record content cannot be modified (row id %)', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "activity_logs_append_only" ON "activity_logs";
CREATE TRIGGER "activity_logs_append_only"
  BEFORE UPDATE OR DELETE ON "activity_logs"
  FOR EACH ROW EXECUTE FUNCTION "reject_activity_log_mutation"();
