import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { workerStoppedSchema } from '@/lib/validation/schemas';
import { markWorkerStopped } from '@/lib/workers';

/**
 * POST /api/worker/stopped
 *
 * Clean-shutdown notification. Releases the exclusive run lease so a
 * replacement worker can start without needing `--force-takeover`.
 */
export const POST = workerRoute(workerStoppedSchema, async ({ workerId, reason }) => {
  await markWorkerStopped(workerId, reason);
  return NextResponse.json({ ok: true });
});
