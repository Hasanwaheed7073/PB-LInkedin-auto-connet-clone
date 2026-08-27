import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { claimNextJob } from '@/lib/queue';
import { workerClaimSchema } from '@/lib/validation/schemas';

/**
 * POST /api/worker/claim
 *
 * Atomically hands out at most one job. All the duplicate protection and
 * schedule enforcement lives in `claimNextJob`; this route is a thin, validated
 * shell around it.
 *
 * Always 200: `status` in the body distinguishes CLAIMED / EMPTY / BLOCKED, so
 * the worker reads one field rather than interpreting status codes.
 */
export const POST = workerRoute(workerClaimSchema, async ({ workerId }) => {
  const outcome = await claimNextJob({ workerId });

  if (outcome.status === 'CLAIMED') {
    const { job } = outcome;
    return NextResponse.json({
      status: 'CLAIMED',
      job: {
        ...job,
        claimExpiresAt: job.claimExpiresAt.toISOString(),
      },
    });
  }

  if (outcome.status === 'BLOCKED') {
    return NextResponse.json({
      status: 'BLOCKED',
      reason: outcome.reason,
      message: outcome.message,
    });
  }

  return NextResponse.json({
    status: 'EMPTY',
    reason: outcome.reason,
    nextEligibleAt: outcome.nextEligibleAt?.toISOString() ?? null,
  });
});
