'use server';

import { revalidatePath } from 'next/cache';

import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import {
  acknowledgeIncident as acknowledgeIncidentRecord,
  resolveIncident as resolveIncidentRecord,
} from '@/lib/incidents';
import { reapExpiredClaims } from '@/lib/queue';
import { clearEmergencyStop, engageEmergencyStop } from '@/lib/safety';
import { detectUnhealthyWorkers } from '@/lib/workers';
import {
  acknowledgeIncidentSchema,
  clearEmergencyStopSchema,
  emergencyStopSchema,
  resolveIncidentSchema,
} from '@/lib/validation/schemas';

/**
 * Safety controls: the emergency stop and the human intervention queue.
 *
 * These are the actions an operator reaches for when something is wrong, so they
 * are the ones that must behave predictably. Notably: engaging the stop always
 * succeeds and always records why; clearing it is *refused* while any blocking
 * incident is unresolved.
 */

function revalidateEverything(): void {
  revalidatePath('/');
  revalidatePath('/campaigns');
  revalidatePath('/queue');
  revalidatePath('/incidents');
  revalidatePath('/workers');
}

export interface EmergencyStopPayload {
  campaignsPaused: number;
  jobsCancelled: number;
  workersSignalled: number;
  alreadyEngaged: boolean;
}

/**
 * STOP ALL AUTOMATION.
 *
 * Latches the persisted kill switch, pauses every active campaign, cancels
 * waiting jobs and signals live workers to drain. A worker polling the control
 * endpoint aborts whatever it is doing within a few seconds.
 *
 * Jobs already in PROCESSING are deliberately left alone: the worker either
 * reports its real outcome or the claim expires and the reaper requeues it.
 * Rewriting them here would race the worker and could lose a genuine result.
 */
export async function emergencyStopAll(
  input: unknown,
): Promise<ActionResult<EmergencyStopPayload>> {
  const user = await requireUser();

  const parsed = validate(emergencyStopSchema, input);
  if (!parsed.ok) return parsed.result;

  const result = await engageEmergencyStop({
    reason: parsed.data.reason,
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
  });

  revalidateEverything();

  return actionOk(
    result,
    `All automation stopped. ${result.campaignsPaused} campaign(s) paused, ` +
      `${result.jobsCancelled} waiting job(s) cancelled.`,
  );
}

/**
 * Clear the emergency stop.
 *
 * Refused while any blocking incident is open - that is what stops a CAPTCHA or
 * an account restriction being dismissed with one click. Clearing the stop does
 * not restart anything: campaigns stay paused and must be re-activated.
 */
export async function clearEmergencyStopAction(
  input: unknown,
): Promise<ActionResult<undefined>> {
  const user = await requireUser();

  const parsed = validate(clearEmergencyStopSchema, input);
  if (!parsed.ok) return parsed.result;

  const result = await clearEmergencyStop({ actorId: user.id, actorName: user.name });

  if (!result.ok) {
    if (result.reason === 'NOT_ENGAGED') {
      return actionError('The emergency stop is not currently engaged.');
    }
    return actionError(
      `${result.count} incident(s) still require human action. Resolve them first - the stop ` +
        'cannot be cleared while automation is known to be unsafe.',
    );
  }

  revalidateEverything();
  return actionOk(
    undefined,
    'Emergency stop cleared. Campaigns are still paused - activate them when you are ready.',
  );
}

export async function acknowledgeIncident(input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();

  const parsed = validate(acknowledgeIncidentSchema, input);
  if (!parsed.ok) return parsed.result;

  const ok = await acknowledgeIncidentRecord(parsed.data.incidentId, {
    actorId: user.id,
    actorName: user.name,
  });

  if (!ok) return actionError('That incident is not open, so it cannot be acknowledged.');

  revalidatePath('/incidents');
  revalidatePath('/');
  return actionOk(undefined, 'Incident acknowledged.');
}

/**
 * Resolve an incident and decide what happens to the affected lead.
 *
 * Resolving never clears the kill switch: that stays a separate, deliberate
 * action, so closing an incident cannot silently restart automation.
 */
export async function resolveIncident(
  input: unknown,
): Promise<ActionResult<{ leadAction: string; campaignPaused: boolean }>> {
  const user = await requireUser();

  const parsed = validate(resolveIncidentSchema, input);
  if (!parsed.ok) return parsed.result;

  const result = await resolveIncidentRecord({
    incidentId: parsed.data.incidentId,
    action: parsed.data.action,
    note: parsed.data.note ?? null,
    actorId: user.id,
    actorName: user.name,
  });

  if (!result.ok) {
    return actionError(
      result.reason === 'NOT_FOUND' ? 'Incident not found.' : 'That incident is already resolved.',
    );
  }

  revalidateEverything();

  const notes: string[] = ['Incident resolved.'];
  if (result.leadAction !== 'none') notes.push(`Lead ${result.leadAction}.`);
  if (result.campaignPaused) notes.push('Campaign paused.');
  notes.push('Automation stays stopped until you clear the emergency stop explicitly.');

  return actionOk(
    { leadAction: result.leadAction, campaignPaused: result.campaignPaused },
    notes.join(' '),
  );
}

/**
 * Recovery sweep, run from the dashboard.
 *
 * Requeues jobs abandoned by a dead worker and flags workers whose heartbeat
 * went stale. Deliberately does not start a replacement worker - launching a
 * second worker automatically is exactly the duplicate-send risk requirement 17
 * rules out.
 */
export async function runRecoverySweep(): Promise<
  ActionResult<{ requeued: number; unhealthyWorkers: number }>
> {
  await requireUser();

  const [reaped, unhealthy] = await Promise.all([
    reapExpiredClaims(),
    detectUnhealthyWorkers(),
  ]);

  revalidateEverything();

  return actionOk(
    { requeued: reaped.requeued, unhealthyWorkers: unhealthy },
    reaped.requeued === 0 && unhealthy === 0
      ? 'Nothing to recover.'
      : `Requeued ${reaped.requeued} abandoned job(s); flagged ${unhealthy} unhealthy worker(s).`,
  );
}
