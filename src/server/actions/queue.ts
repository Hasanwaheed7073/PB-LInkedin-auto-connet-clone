'use server';

import { revalidatePath } from 'next/cache';

import { logActivity } from '@/lib/activity';
import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { cancelJobSchema } from '@/lib/validation/schemas';

/**
 * Queue actions available to the operator.
 *
 * Everything here refuses to touch a PROCESSING job: that row is owned by a
 * worker holding a claim token, and rewriting it from the dashboard would race
 * the worker and could lose a real result.
 */

export async function cancelQueueJob(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(cancelJobSchema, input);
  if (!parsed.ok) return parsed.result;

  const job = await prisma.queueJob.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      status: true,
      leadId: true,
      campaignId: true,
      lead: { select: { fullName: true } },
    },
  });
  if (!job) return actionError('Queue job not found.');

  if (job.status === 'PROCESSING') {
    return actionError(
      'This job is being processed by a worker right now. Use the emergency stop if you need to ' +
        'interrupt it, rather than cancelling the row underneath the worker.',
    );
  }
  if (job.status !== 'WAITING' && job.status !== 'REQUIRES_REVIEW') {
    return actionError(`Only waiting jobs can be cancelled; this one is ${job.status}.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.queueJob.update({
      where: { id: job.id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        error: parsed.data.reason
          ? `Cancelled by ${user.name}: ${parsed.data.reason}`
          : `Cancelled by ${user.name}`,
      },
    });

    // Return the lead to PENDING so it can be re-queued deliberately later.
    await tx.lead.updateMany({
      where: { id: job.leadId, status: { in: ['PROCESSING', 'REQUIRES_REVIEW'] } },
      data: { status: 'PENDING' },
    });

    await logActivity(
      {
        action: 'JOB_CANCELLED',
        result: 'CANCELLED',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        campaignId: job.campaignId,
        leadId: job.leadId,
        queueJobId: job.id,
        message: `Cancelled queued job for ${job.lead.fullName}.`,
        metadata: { reason: parsed.data.reason ?? null },
      },
      tx,
    );
  });

  revalidatePath('/queue');
  revalidatePath('/');
  return actionOk({ id: job.id }, 'Job cancelled.');
}

/**
 * Move a waiting job to the front of the queue.
 *
 * Only reprioritises - it does not bypass operating hours, daily limits, or any
 * safety gate. Those are all still enforced at claim time.
 */
export async function expediteQueueJob(jobId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const job = await prisma.queueJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      campaignId: true,
      leadId: true,
      lead: { select: { fullName: true } },
    },
  });
  if (!job) return actionError('Queue job not found.');
  if (job.status !== 'WAITING') {
    return actionError(`Only a waiting job can be expedited; this one is ${job.status}.`);
  }

  await prisma.queueJob.update({
    where: { id: jobId },
    data: { priority: -100, scheduledFor: new Date() },
  });

  await logActivity({
    action: 'QUEUE_GENERATED',
    result: 'INFO',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: job.campaignId,
    leadId: job.leadId,
    queueJobId: job.id,
    message: `Moved ${job.lead.fullName} to the front of the queue.`,
  });

  revalidatePath('/queue');
  return actionOk(
    { id: jobId },
    'Job moved to the front. Operating hours and daily limits still apply.',
  );
}

/**
 * Requeue a job sitting in REQUIRES_REVIEW.
 *
 * Safe against duplicates: the partial unique index on COMPLETED jobs and the
 * `invitationSentAt` check mean a lead that was actually contacted cannot be
 * contacted again, even if this is used by mistake.
 */
export async function requeueJob(jobId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const job = await prisma.queueJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      campaignId: true,
      leadId: true,
      attempts: true,
      maxAttempts: true,
      lead: { select: { fullName: true, invitationSentAt: true } },
    },
  });
  if (!job) return actionError('Queue job not found.');

  if (job.status !== 'REQUIRES_REVIEW' && job.status !== 'FAILED') {
    return actionError(
      `Only a failed or under-review job can be requeued; this one is ${job.status}.`,
    );
  }
  if (job.lead.invitationSentAt) {
    return actionError(
      `${job.lead.fullName} has already been sent an invitation. Refusing to requeue - that would ` +
        'risk a duplicate.',
    );
  }

  const openBlocking = await prisma.incident.count({
    where: { queueJobId: jobId, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
  });
  if (openBlocking > 0) {
    return actionError(
      'Resolve the incident attached to this job before requeuing it, so the underlying problem ' +
        'is dealt with first.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.queueJob.update({
      where: { id: jobId },
      data: {
        status: 'WAITING',
        scheduledFor: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        errorClass: 'NONE',
        result: null,
        resultPageState: null,
        claimedByWorkerId: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        // Give it a fresh attempt budget, since the operator has looked at it.
        maxAttempts: job.attempts + 1,
      },
    });

    await tx.lead.update({
      where: { id: job.leadId },
      data: { status: 'PENDING' },
    });

    await logActivity(
      {
        action: 'JOB_RETRY_SCHEDULED',
        result: 'INFO',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        campaignId: job.campaignId,
        leadId: job.leadId,
        queueJobId: job.id,
        message: `Requeued ${job.lead.fullName} after operator review.`,
      },
      tx,
    );
  });

  revalidatePath('/queue');
  revalidatePath('/incidents');
  return actionOk({ id: jobId }, 'Job requeued.');
}
