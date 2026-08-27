import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { workerRegisterSchema } from '@/lib/validation/schemas';
import { registerWorker } from '@/lib/workers';

/**
 * POST /api/worker/register
 *
 * Grants the exclusive run lease. A second worker is refused while the current
 * holder's heartbeat is fresh - this is the primary defence against two workers
 * double-sending to the same lead list.
 */
export const POST = workerRoute(workerRegisterSchema, async (input) => {
  const result = await registerWorker(input);

  if (!result.ok) {
    // 409: the request was well-formed, the lease is simply taken.
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        holder: {
          ...result.holder,
          lastHeartbeatAt: result.holder.lastHeartbeatAt.toISOString(),
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    workerId: result.workerId,
    leaseExpiresAt: result.leaseExpiresAt.toISOString(),
    tookOverFrom: result.tookOverFrom,
  });
});
