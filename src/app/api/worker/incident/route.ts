import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { openIncident } from '@/lib/incidents';
import { createIncidentSchema } from '@/lib/validation/schemas';

/**
 * POST /api/worker/incident
 *
 * Lets the worker escalate a condition that is not tied to a claimed job - a
 * failed session check, a crash, an unreachable browser.
 *
 * `engageKillSwitch` is accepted from the worker because the worker is the only
 * component that can see the page. It is still the server that decides what
 * latching the switch does (pausing campaigns, shutting the gate), and every
 * such request is written to the audit log.
 */
export const POST = workerRoute(createIncidentSchema, async (input) => {
  const result = await openIncident({
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    blocksWorker: input.blocksWorker,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    queueJobId: input.queueJobId ?? null,
    workerId: input.workerId ?? null,
    pageState: input.pageState ?? null,
    pageUrl: input.pageUrl ?? null,
    screenshotPath: input.screenshotPath ?? null,
    engageKillSwitch: input.engageKillSwitch,
  });

  return NextResponse.json({
    ok: true,
    incidentId: result.incidentId,
    deduplicated: result.deduplicated,
    killSwitchEngaged: result.killSwitchEngaged,
  });
});
