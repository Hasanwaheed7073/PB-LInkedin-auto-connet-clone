import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { completeJob } from '@/lib/queue';
import { workerCompleteSchema } from '@/lib/validation/schemas';

/**
 * POST /api/worker/complete
 *
 * Records a verified outcome. The `claimToken` must match the current holder, so
 * a worker whose lease expired cannot overwrite the result produced by whoever
 * picked the job up afterwards.
 */
export const POST = workerRoute(workerCompleteSchema, async (input) => {
  const result = await completeJob({
    jobId: input.jobId,
    claimToken: input.claimToken,
    workerId: input.workerId,
    result: input.result,
    pageState: input.pageState ?? null,
    screenshotPath: input.screenshotPath ?? null,
    durationMs: input.durationMs ?? null,
    detail: (input.detail ?? undefined) as never,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    leadStatus: result.leadStatus,
    campaignCompleted: result.campaignCompleted,
  });
});
