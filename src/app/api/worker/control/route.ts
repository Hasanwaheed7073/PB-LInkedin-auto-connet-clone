import { NextResponse } from 'next/server';

import { workerRoute } from '@/lib/api';
import { evaluateWorkerGate } from '@/lib/safety';
import { workerClaimSchema } from '@/lib/validation/schemas';

/**
 * POST /api/worker/control
 *
 * The safety gate, polled by the worker before every claim and repeatedly while
 * a job is in flight. Cheap on purpose - it is called every few seconds, and it
 * is what makes the emergency stop interrupt work already running rather than
 * only preventing the next job.
 */
export const POST = workerRoute(workerClaimSchema, async ({ workerId }) => {
  const gate = await evaluateWorkerGate(workerId);
  return NextResponse.json(gate);
});
