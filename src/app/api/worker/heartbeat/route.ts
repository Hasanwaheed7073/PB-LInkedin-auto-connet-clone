import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { workerHeartbeatSchema } from '@/lib/validation/schemas';
import { recordHeartbeat } from '@/lib/workers';

/**
 * POST /api/worker/heartbeat
 *
 * Records liveness and extends the run lease. The response tells the worker
 * whether it still holds the lease, so a worker that was taken over shuts itself
 * down instead of continuing to act.
 */
export const POST = workerRoute(workerHeartbeatSchema, async (input) => {
  const result = await recordHeartbeat(input);

  // Returned as 200 with an `ok: false` body, consistent with the other worker
  // endpoints: the request succeeded, the answer is just "I do not know you".
  // The worker inspects the body rather than having to interpret status codes.
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason });
  }

  return NextResponse.json({
    ok: true,
    leaseExpiresAt: result.leaseExpiresAt.toISOString(),
    holdsLease: result.holdsLease,
    controlEpoch: result.controlEpoch,
  });
});
