import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { failJob } from '@/lib/queue';
import { workerFailSchema } from '@/lib/validation/schemas';

/**
 * POST /api/worker/fail
 *
 * Records a failure. `failJob` decides the disposition:
 *  - TECHNICAL -> retried with exponential backoff
 *  - PERMANENT -> failed, not retried
 *  - SAFETY    -> escalated to a human, never retried, kill switch latched where
 *                 the state indicates a LinkedIn security control
 *
 * The worker does not get to choose whether a safety state is retried; that is
 * decided here from the reported error class and page state.
 */
export const POST = workerRoute(workerFailSchema, async (input) => {
  const result = await failJob({
    jobId: input.jobId,
    claimToken: input.claimToken,
    workerId: input.workerId,
    error: input.error,
    errorClass: input.errorClass,
    pageState: input.pageState ?? null,
    pageUrl: input.pageUrl ?? null,
    screenshotPath: input.screenshotPath ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    disposition: result.disposition,
    nextAttemptAt: result.nextAttemptAt?.toISOString() ?? null,
    incidentId: result.incidentId,
    killSwitchEngaged: result.killSwitchEngaged,
  });
});
