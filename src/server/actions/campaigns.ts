'use server';

import { revalidatePath } from 'next/cache';

import { logActivity } from '@/lib/activity';
import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { cancelCampaignQueue, generateQueueForCampaign, scheduleBurst } from '@/lib/queue';
import { getSystemState } from '@/lib/safety';
import { renderTemplate } from '@/lib/template';
import {
  activateCampaignSchema,
  assignLeadsSchema,
  campaignIdSchema,
  createCampaignSchema,
  generateQueueSchema,
  scheduleBurstSchema,
  pauseCampaignSchema,
  updateCampaignSchema,
} from '@/lib/validation/schemas';

/**
 * Campaign management server actions.
 *
 * The important rule (requirement 4): a campaign never runs without explicit
 * activation. `activateCampaign` is the only path to `RUNNING`, it demands
 * `confirm: true`, and it runs a set of pre-flight checks that will refuse to
 * activate a campaign that would misbehave.
 */

export async function createCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(createCampaignSchema, input);
  if (!parsed.ok) return parsed.result;

  const { name, description, messageTemplateId, settings } = parsed.data;

  const clash = await prisma.campaign.findUnique({ where: { name }, select: { id: true } });
  if (clash) return actionError(`A campaign named "${name}" already exists.`);

  if (messageTemplateId) {
    const template = await prisma.messageTemplate.findUnique({
      where: { id: messageTemplateId },
      select: { id: true },
    });
    if (!template) return actionError('The selected message template no longer exists.');
  }

  const campaign = await prisma.campaign.create({
    data: {
      name,
      description: description ?? null,
      messageTemplateId: messageTemplateId ?? null,
      createdById: user.id,
      // New campaigns always start as DRAFT and inactive.
      status: 'DRAFT',
      active: false,
      settings: { create: settings },
    },
    select: { id: true },
  });

  await logActivity({
    action: 'CAMPAIGN_CREATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: campaign.id,
    message: `Created campaign "${name}" as DRAFT.`,
    metadata: { settings },
  });

  revalidatePath('/campaigns');
  return actionOk({ id: campaign.id }, `Campaign "${name}" created as a draft.`);
}

export async function updateCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(updateCampaignSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, name, description, messageTemplateId, settings } = parsed.data;

  const existing = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, active: true },
  });
  if (!existing) return actionError('Campaign not found.');

  // Editing schedule or template while jobs are being processed would make the
  // running campaign behave differently from what was activated.
  if (existing.active && existing.status === 'RUNNING') {
    return actionError(
      'Pause the campaign before editing it. Changing the schedule or template while it is ' +
        'running would apply mid-run and make the audit trail misleading.',
    );
  }

  if (name !== existing.name) {
    const clash = await prisma.campaign.findUnique({ where: { name }, select: { id: true } });
    if (clash) return actionError(`A campaign named "${name}" already exists.`);
  }

  await prisma.campaign.update({
    where: { id },
    data: {
      name,
      description: description ?? null,
      messageTemplateId: messageTemplateId ?? null,
      settings: { update: settings },
    },
  });

  await logActivity({
    action: 'CAMPAIGN_UPDATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: id,
    message: `Updated campaign "${name}".`,
    metadata: { settings },
  });

  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${id}`);
  return actionOk({ id }, 'Campaign updated.');
}

export interface ActivationCheck {
  label: string;
  ok: boolean;
  detail: string;
  /** A failed blocking check prevents activation; a warning is advisory. */
  blocking: boolean;
}

/**
 * Pre-flight checks, shown on the campaign page before activation and
 * re-evaluated inside `activateCampaign`.
 *
 * Cheap to run and read-only, so the operator can see exactly why a campaign
 * cannot start rather than getting a bare error.
 */
export async function getActivationChecks(campaignId: string): Promise<ActivationCheck[]> {
  await requireUser();
  const env = serverEnv();

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { settings: true, messageTemplate: true },
  });
  if (!campaign) return [{ label: 'Campaign', ok: false, detail: 'Not found', blocking: true }];

  const [pendingLeads, systemState, blockingIncidents] = await Promise.all([
    prisma.lead.count({ where: { campaignId, status: { in: ['PENDING', 'FAILED'] } } }),
    getSystemState(),
    prisma.incident.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
    }),
  ]);

  const checks: ActivationCheck[] = [];

  checks.push({
    label: 'Emergency stop',
    ok: !systemState.killSwitchEngaged,
    detail: systemState.killSwitchEngaged
      ? `Engaged: ${systemState.killSwitchReason ?? 'no reason recorded'}. Clear it before activating.`
      : 'Not engaged',
    blocking: true,
  });

  checks.push({
    label: 'Open blocking incidents',
    ok: blockingIncidents === 0,
    detail:
      blockingIncidents === 0
        ? 'None'
        : `${blockingIncidents} incident(s) require human action first`,
    blocking: true,
  });

  checks.push({
    label: 'Schedule configured',
    ok: !!campaign.settings && campaign.settings.operatingDays.length > 0,
    detail: campaign.settings
      ? `${campaign.settings.operatingDays.length} operating day(s), ${campaign.settings.timezone}`
      : 'No settings row',
    blocking: true,
  });

  checks.push({
    label: 'Leads to work',
    ok: pendingLeads > 0,
    detail:
      pendingLeads > 0
        ? `${pendingLeads} lead(s) pending`
        : 'No pending leads assigned to this campaign',
    blocking: true,
  });

  const dailyLimit = campaign.settings?.dailyLimit ?? 0;
  checks.push({
    label: 'Daily limits',
    ok: dailyLimit > 0 && dailyLimit <= env.GLOBAL_DAILY_ACTION_LIMIT,
    detail:
      dailyLimit > env.GLOBAL_DAILY_ACTION_LIMIT
        ? `Campaign limit ${dailyLimit} exceeds the global limit ${env.GLOBAL_DAILY_ACTION_LIMIT}; the global limit will apply`
        : `${dailyLimit}/day (global ceiling ${env.GLOBAL_DAILY_ACTION_LIMIT}/day)`,
    // Advisory: the lower limit is enforced regardless, so this is safe.
    blocking: false,
  });

  // Template check: verify it actually renders against real leads from this
  // campaign, not against a made-up example.
  if (campaign.messageTemplate) {
    const sample = await prisma.lead.findMany({
      where: { campaignId, status: { in: ['PENDING', 'FAILED'] } },
      select: { firstName: true, lastName: true, company: true, jobTitle: true },
      take: 200,
    });

    let failures = 0;
    for (const lead of sample) {
      const rendered = renderTemplate(campaign.messageTemplate.body, lead, {
        maxLength: env.MAX_CONNECTION_NOTE_CHARS,
      });
      if (!rendered.ok) failures += 1;
    }

    checks.push({
      label: 'Message template renders',
      ok: failures === 0,
      detail:
        failures === 0
          ? `Renders for all ${sample.length} sampled lead(s)`
          : `${failures} of ${sample.length} sampled lead(s) are missing template values and would be skipped`,
      blocking: false,
    });
  } else {
    checks.push({
      label: 'Message template',
      ok: true,
      detail: 'None set - invitations will be sent without a note',
      blocking: false,
    });
  }

  return checks;
}

/**
 * Activate a campaign.
 *
 * The only route to `RUNNING`. Requires explicit confirmation, re-runs every
 * blocking pre-flight check server-side, and optionally generates the queue.
 */
export async function activateCampaign(
  input: unknown,
): Promise<ActionResult<{ id: string; queued: number }>> {
  const user = await requireUser();

  const parsed = validate(activateCampaignSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, generateQueue } = parsed.data;

  const checks = await getActivationChecks(id);
  const failed = checks.filter((c) => c.blocking && !c.ok);
  if (failed.length > 0) {
    return actionError(
      `Cannot activate: ${failed.map((f) => `${f.label} - ${f.detail}`).join('; ')}`,
    );
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) return actionError('Campaign not found.');
  if (campaign.status === 'RUNNING') return actionError('This campaign is already running.');
  if (campaign.status === 'COMPLETED') {
    return actionError(
      'This campaign is COMPLETED. Create a new campaign rather than restarting a finished one.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id },
      data: {
        status: 'RUNNING',
        active: true,
        activatedAt: new Date(),
        activatedBy: user.name,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
        lastError: null,
      },
    });

    await logActivity(
      {
        action: 'CAMPAIGN_ACTIVATED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        campaignId: id,
        message: `Campaign "${campaign.name}" activated by ${user.name}.`,
        metadata: { generateQueue },
      },
      tx,
    );
  });

  let queued = 0;
  if (generateQueue) {
    const result = await generateQueueForCampaign({
      campaignId: id,
      actorId: user.id,
      actorName: user.name,
    });
    queued = result.created;
  }

  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${id}`);
  revalidatePath('/queue');
  revalidatePath('/');

  return actionOk(
    { id, queued },
    `Campaign "${campaign.name}" is running${queued > 0 ? `; ${queued} job(s) queued.` : '.'}`,
  );
}

export async function pauseCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(pauseCampaignSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, reason } = parsed.data;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) return actionError('Campaign not found.');
  if (campaign.status === 'PAUSED') return actionError('This campaign is already paused.');

  await prisma.$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id },
      data: {
        status: 'PAUSED',
        active: false,
        pausedAt: new Date(),
        pausedBy: user.name,
        pauseReason: reason ?? 'Paused by operator',
      },
    });

    await logActivity(
      {
        action: 'CAMPAIGN_PAUSED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        campaignId: id,
        message: `Campaign "${campaign.name}" paused${reason ? `: ${reason}` : ''}.`,
      },
      tx,
    );
  });

  // Waiting jobs are deliberately left in place. Pausing means "stop starting
  // new work", not "throw away the plan" - resuming should pick up where it
  // left off. A job already in flight finishes and reports normally.
  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${id}`);
  revalidatePath('/');

  return actionOk({ id }, `Campaign "${campaign.name}" paused.`);
}

export async function resumeCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(campaignIdSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id } = parsed.data;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) return actionError('Campaign not found.');
  if (campaign.status !== 'PAUSED') {
    return actionError(`Only a PAUSED campaign can be resumed; this one is ${campaign.status}.`);
  }

  // Resuming is an activation, so it goes through the same blocking checks.
  const checks = await getActivationChecks(id);
  const failed = checks.filter((c) => c.blocking && !c.ok);
  if (failed.length > 0) {
    return actionError(
      `Cannot resume: ${failed.map((f) => `${f.label} - ${f.detail}`).join('; ')}`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaign.update({
      where: { id },
      data: {
        status: 'RUNNING',
        active: true,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
      },
    });

    await logActivity(
      {
        action: 'CAMPAIGN_RESUMED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        campaignId: id,
        message: `Campaign "${campaign.name}" resumed by ${user.name}.`,
      },
      tx,
    );
  });

  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${id}`);
  revalidatePath('/');

  return actionOk({ id }, `Campaign "${campaign.name}" resumed.`);
}

export async function generateCampaignQueue(
  input: unknown,
): Promise<ActionResult<{ created: number; skipped: number }>> {
  const user = await requireUser();

  const parsed = validate(generateQueueSchema, input);
  if (!parsed.ok) return parsed.result;

  const campaign = await prisma.campaign.findUnique({
    where: { id: parsed.data.campaignId },
    select: { id: true, name: true, settings: { select: { id: true } } },
  });
  if (!campaign) return actionError('Campaign not found.');
  if (!campaign.settings) return actionError('This campaign has no schedule configured.');

  const result = await generateQueueForCampaign({
    campaignId: parsed.data.campaignId,
    limit: parsed.data.limit,
    actorId: user.id,
    actorName: user.name,
  });

  revalidatePath('/queue');
  revalidatePath(`/campaigns/${parsed.data.campaignId}`);

  return actionOk(
    {
      created: result.created,
      skipped: result.skippedAlreadyQueued + result.skippedAlreadyResolved,
    },
    result.created > 0
      ? `Queued ${result.created} job(s).`
      : 'Nothing new to queue - every pending lead already has a job.',
  );
}

export async function assignLeadsToCampaign(
  input: unknown,
): Promise<ActionResult<{ assigned: number }>> {
  const user = await requireUser();

  const parsed = validate(assignLeadsSchema, input);
  if (!parsed.ok) return parsed.result;

  const { campaignId, leadIds } = parsed.data;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true },
  });
  if (!campaign) return actionError('Campaign not found.');

  // Never move a lead the worker currently holds.
  const result = await prisma.lead.updateMany({
    where: { id: { in: leadIds }, status: { not: 'PROCESSING' } },
    data: { campaignId },
  });

  await logActivity({
    action: 'CAMPAIGN_UPDATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId,
    message: `Assigned ${result.count} lead(s) to "${campaign.name}".`,
    metadata: { requested: leadIds.length, assigned: result.count },
  });

  revalidatePath('/leads');
  revalidatePath(`/campaigns/${campaignId}`);

  const skipped = leadIds.length - result.count;
  return actionOk(
    { assigned: result.count },
    skipped > 0
      ? `Assigned ${result.count} lead(s); ${skipped} skipped because they are being processed.`
      : `Assigned ${result.count} lead(s).`,
  );
}

/**
 * Cancel a campaign's waiting queue without changing its status. Useful for
 * rebuilding a schedule after editing operating hours.
 */
export async function clearCampaignQueue(
  input: unknown,
): Promise<ActionResult<{ cancelled: number }>> {
  const user = await requireUser();

  const parsed = validate(campaignIdSchema, input);
  if (!parsed.ok) return parsed.result;

  const campaign = await prisma.campaign.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, name: true },
  });
  if (!campaign) return actionError('Campaign not found.');

  const cancelled = await cancelCampaignQueue(
    parsed.data.id,
    `Queue cleared by ${user.name}`,
  );

  await logActivity({
    action: 'JOB_CANCELLED',
    result: 'CANCELLED',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: parsed.data.id,
    message: `Cleared ${cancelled} waiting job(s) from "${campaign.name}".`,
  });

  revalidatePath('/queue');
  revalidatePath(`/campaigns/${parsed.data.id}`);

  return actionOk({ cancelled }, `Cancelled ${cancelled} waiting job(s).`);
}

/**
 * Schedule a burst: send `count` invitations over the next `minutes`.
 *
 * The daily control an operator actually wants - "thirty over the next half
 * hour" - without editing the campaign's standing schedule or regenerating a
 * queue. It brings jobs forward, spreads them evenly, and authorises the worker
 * to run outside the operating window until the burst expires.
 *
 * It cannot exceed a daily limit. Both ceilings are counted against what has
 * really been sent today and the request is trimmed to fit, so the operator
 * gets what is available with an explanation instead of a rejection.
 */
export async function scheduleBurstAction(
  input: unknown,
): Promise<
  ActionResult<{
    scheduled: number;
    trimReason: string | null;
    firstAt: string | null;
    lastAt: string | null;
    remainingTodayAfter: number;
  }>
> {
  const user = await requireUser();

  const parsed = validate(scheduleBurstSchema, input);
  if (!parsed.ok) return parsed.result;

  const campaign = await prisma.campaign.findUnique({
    where: { id: parsed.data.campaignId },
    select: { id: true, name: true, status: true, active: true, settings: { select: { id: true } } },
  });
  if (!campaign) return actionError('Campaign not found.');
  if (!campaign.settings) return actionError('This campaign has no schedule configured.');
  if (!campaign.active || campaign.status !== 'RUNNING') {
    return actionError(
      'Activate the campaign first. A burst schedules work; it does not start a paused campaign.',
    );
  }

  const result = await scheduleBurst({
    campaignId: parsed.data.campaignId,
    count: parsed.data.count,
    minutes: parsed.data.minutes,
    actorId: user.id,
    actorName: user.name,
  });

  revalidatePath('/queue');
  revalidatePath(`/campaigns/${parsed.data.campaignId}`);
  revalidatePath('/');

  if (result.scheduled === 0) {
    return actionError(
      result.trimReason === 'NOT_ENOUGH_LEADS'
        ? 'No leads are waiting in this campaign.'
        : "Today's limit is already used up. Nothing was scheduled.",
    );
  }

  const explanation =
    result.trimReason === 'CAMPAIGN_DAILY_LIMIT'
      ? " (trimmed to the campaign's daily limit)"
      : result.trimReason === 'GLOBAL_DAILY_LIMIT'
        ? ' (trimmed to the global daily ceiling)'
        : result.trimReason === 'NOT_ENOUGH_LEADS'
          ? ' (all the leads that were waiting)'
          : '';

  return actionOk(
    {
      scheduled: result.scheduled,
      trimReason: result.trimReason,
      firstAt: result.firstAt?.toISOString() ?? null,
      lastAt: result.lastAt?.toISOString() ?? null,
      remainingTodayAfter: result.remainingTodayAfter,
    },
    `${result.scheduled} invitation(s) scheduled over the next ${parsed.data.minutes} minute(s)${explanation}. The worker must be running for them to go out.`,
  );
}
