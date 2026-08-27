'use server';

import { revalidatePath } from 'next/cache';

import { logActivity } from '@/lib/activity';
import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { describeRenderFailure, inspectTemplateBody, renderTemplate } from '@/lib/template';
import {
  messageTemplateSchema,
  templatePreviewSchema,
  updateMessageTemplateSchema,
} from '@/lib/validation/schemas';

/**
 * Message-template actions.
 *
 * The preview (requirement 5) renders against a *real lead from the database*,
 * never a fabricated example, so what the operator approves is what will
 * actually be sent.
 */

export interface TemplatePreviewPayload {
  /** Null when the template cannot render for this lead. */
  rendered: string | null;
  error: string | null;
  length: number;
  limit: number;
  variablesUsed: string[];
  unknownVariables: string[];
  lead: {
    id: string;
    fullName: string;
    linkedinUrl: string;
    company: string | null;
    jobTitle: string | null;
  } | null;
  /** How many leads in the database the template would fail to render for. */
  wouldSkipCount: number;
  sampledLeads: number;
}

/**
 * Render a template against a real lead.
 *
 * Also reports how many leads it would fail for, so a template that works for
 * the previewed lead but breaks for a third of the list does not get approved by
 * accident.
 */
export async function previewTemplate(
  input: unknown,
): Promise<ActionResult<TemplatePreviewPayload>> {
  await requireUser();
  const env = serverEnv();

  const parsed = validate(templatePreviewSchema, input);
  if (!parsed.ok) return parsed.result;

  const { body, leadId } = parsed.data;
  const { used, unknown } = inspectTemplateBody(body);

  const lead = leadId
    ? await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          id: true,
          fullName: true,
          linkedinUrl: true,
          firstName: true,
          lastName: true,
          company: true,
          jobTitle: true,
        },
      })
    : await prisma.lead.findFirst({
        // Prefer a lead that will actually be contacted.
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fullName: true,
          linkedinUrl: true,
          firstName: true,
          lastName: true,
          company: true,
          jobTitle: true,
        },
      });

  if (!lead) {
    return actionOk({
      rendered: null,
      error:
        'No leads in the database yet, so this cannot be previewed against real data. Import a ' +
        'CSV first - the preview deliberately does not use made-up example values.',
      length: 0,
      limit: env.MAX_CONNECTION_NOTE_CHARS,
      variablesUsed: used,
      unknownVariables: unknown,
      lead: null,
      wouldSkipCount: 0,
      sampledLeads: 0,
    });
  }

  const result = renderTemplate(body, lead, { maxLength: env.MAX_CONNECTION_NOTE_CHARS });

  // Sample the wider list so coverage problems surface before activation.
  const sample = await prisma.lead.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] } },
    select: { firstName: true, lastName: true, company: true, jobTitle: true },
    take: 500,
  });
  let wouldSkipCount = 0;
  for (const candidate of sample) {
    const attempt = renderTemplate(body, candidate, {
      maxLength: env.MAX_CONNECTION_NOTE_CHARS,
    });
    if (!attempt.ok) wouldSkipCount += 1;
  }

  return actionOk({
    rendered: result.ok ? result.text : null,
    error: result.ok ? null : describeRenderFailure(result),
    length: result.ok ? result.text.length : 0,
    limit: env.MAX_CONNECTION_NOTE_CHARS,
    variablesUsed: used,
    unknownVariables: unknown,
    lead: {
      id: lead.id,
      fullName: lead.fullName,
      linkedinUrl: lead.linkedinUrl,
      company: lead.company,
      jobTitle: lead.jobTitle,
    },
    wouldSkipCount,
    sampledLeads: sample.length,
  });
}

export async function createTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(messageTemplateSchema, input);
  if (!parsed.ok) return parsed.result;

  const clash = await prisma.messageTemplate.findUnique({
    where: { name: parsed.data.name },
    select: { id: true },
  });
  if (clash) return actionError(`A template named "${parsed.data.name}" already exists.`);

  const template = await prisma.messageTemplate.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      body: parsed.data.body,
    },
    select: { id: true },
  });

  await logActivity({
    action: 'TEMPLATE_CREATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    message: `Created message template "${parsed.data.name}".`,
  });

  revalidatePath('/templates');
  return actionOk({ id: template.id }, 'Template created.');
}

/**
 * Update a template.
 *
 * Refused while a campaign using it is running: the note is part of what was
 * activated, and changing it mid-run would mean the audit log no longer reflects
 * what was actually sent.
 */
export async function updateTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(updateMessageTemplateSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, name, description, body } = parsed.data;

  const existing = await prisma.messageTemplate.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      campaigns: {
        where: { active: true, status: 'RUNNING' },
        select: { id: true, name: true },
      },
    },
  });
  if (!existing) return actionError('Template not found.');

  if (existing.campaigns.length > 0) {
    return actionError(
      `This template is in use by running campaign(s): ${existing.campaigns
        .map((c) => c.name)
        .join(', ')}. Pause them before editing the note.`,
    );
  }

  if (name !== existing.name) {
    const clash = await prisma.messageTemplate.findUnique({ where: { name }, select: { id: true } });
    if (clash) return actionError(`A template named "${name}" already exists.`);
  }

  await prisma.messageTemplate.update({
    where: { id },
    data: { name, description: description ?? null, body },
  });

  await logActivity({
    action: 'TEMPLATE_UPDATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    message: `Updated message template "${name}".`,
  });

  revalidatePath('/templates');
  return actionOk({ id }, 'Template updated.');
}

export async function deleteTemplate(templateId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const template = await prisma.messageTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, name: true, campaigns: { select: { id: true, name: true } } },
  });
  if (!template) return actionError('Template not found.');

  if (template.campaigns.length > 0) {
    return actionError(
      `This template is attached to ${template.campaigns.length} campaign(s): ${template.campaigns
        .map((c) => c.name)
        .join(', ')}. Detach it first.`,
    );
  }

  await prisma.messageTemplate.delete({ where: { id: templateId } });

  await logActivity({
    action: 'TEMPLATE_UPDATED',
    result: 'INFO',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    message: `Deleted message template "${template.name}".`,
  });

  revalidatePath('/templates');
  return actionOk({ id: templateId }, 'Template deleted.');
}
