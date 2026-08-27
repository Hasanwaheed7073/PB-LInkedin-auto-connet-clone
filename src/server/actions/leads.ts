'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { logActivity } from '@/lib/activity';
import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import {
  analyzeLeadCsv,
  buildImportPreview,
  summarizePreview,
  type ImportPreview,
  type ImportPreviewSummary,
} from '@/lib/csv';
import { prisma } from '@/lib/db';
import { normalizeLinkedInUrl, splitFullName } from '@/lib/linkedin-url';
import {
  confirmImportSchema,
  createLeadSchema,
  csvUploadSchema,
  setLeadStatusSchema,
  updateLeadSchema,
} from '@/lib/validation/schemas';

/**
 * Lead management server actions.
 *
 * The import is deliberately two-phase: `previewLeadImport` analyses and reports,
 * `confirmLeadImport` writes. Nothing is created until the operator confirms a
 * count they have actually seen (requirement 3).
 */

export interface ImportPreviewPayload {
  summary: ImportPreviewSummary;
  /** First rows that will be created, for the preview table. */
  sample: ImportPreview['toCreate'];
  /** Rows already present in the database, so the operator sees what is skipped. */
  alreadyInDatabase: {
    fullName: string;
    linkedinUrl: string;
    existingStatus: string;
    existingCampaign: string | null;
  }[];
  rejected: { rowNumber: number; reason: string; message: string; rawUrl: string }[];
  duplicatesInFile: { rowNumber: number; message: string; rawUrl: string }[];
  unmatchedHeaders: string[];
  detectedColumns: Record<string, string | undefined>;
  parseErrors: string[];
}

const SAMPLE_SIZE = 25;

/**
 * Analyse a CSV and report exactly what an import would do. Read-only - not a
 * single row is written here.
 */
export async function previewLeadImport(
  input: unknown,
): Promise<ActionResult<ImportPreviewPayload>> {
  await requireUser();

  const parsed = validate(csvUploadSchema, input);
  if (!parsed.ok) return parsed.result;

  const analysis = analyzeLeadCsv(parsed.data.csv);

  if (analysis.prepared.length === 0 && analysis.rejected.length > 0) {
    const noUrlColumn = analysis.rejected.find((r) => r.reason === 'NO_URL_COLUMN');
    if (noUrlColumn) return actionError(noUrlColumn.message);
  }

  // Only the URLs present in this file are looked up, so the query stays bounded
  // regardless of how many leads already exist.
  const urls = analysis.prepared.map((p) => p.linkedinUrl);
  const existingRows =
    urls.length === 0
      ? []
      : await prisma.lead.findMany({
          where: { linkedinUrl: { in: urls } },
          select: {
            linkedinUrl: true,
            fullName: true,
            status: true,
            campaign: { select: { name: true } },
          },
        });

  const preview = buildImportPreview(
    analysis,
    existingRows.map((r) => ({
      linkedinUrl: r.linkedinUrl,
      fullName: r.fullName,
      status: r.status,
      campaignName: r.campaign?.name ?? null,
    })),
  );

  return actionOk({
    summary: summarizePreview(preview),
    sample: preview.toCreate.slice(0, SAMPLE_SIZE),
    alreadyInDatabase: preview.alreadyInDatabase.slice(0, SAMPLE_SIZE).map((entry) => ({
      fullName: entry.row.fullName,
      linkedinUrl: entry.row.linkedinUrl,
      existingStatus: entry.existing.status,
      existingCampaign: entry.existing.campaignName,
    })),
    rejected: analysis.rejected
      .filter((r) => r.reason !== 'BLANK_ROW')
      .slice(0, 100)
      .map((r) => ({
        rowNumber: r.rowNumber,
        reason: r.reason,
        message: r.message,
        rawUrl: r.rawUrl,
      })),
    duplicatesInFile: analysis.duplicatesInFile.slice(0, 100).map((r) => ({
      rowNumber: r.rowNumber,
      message: r.message,
      rawUrl: r.rawUrl,
    })),
    unmatchedHeaders: analysis.unmatchedHeaders,
    detectedColumns: analysis.mapping,
    parseErrors: analysis.parseErrors,
  });
}

export interface ImportResultPayload {
  created: number;
  skippedExisting: number;
  skippedDuplicateInFile: number;
  rejected: number;
  batchId: string;
}

/**
 * Write the import.
 *
 * Guards, in order:
 *  1. The CSV is re-analysed server-side; the preview payload is never trusted.
 *  2. `expectedCount` must still match, so a concurrent change cannot cause a
 *     different number of leads to be created than the operator confirmed.
 *  3. `createMany({ skipDuplicates })` plus the unique index on `linkedinUrl`
 *     means a race cannot create the same person twice.
 */
export async function confirmLeadImport(
  input: unknown,
): Promise<ActionResult<ImportResultPayload>> {
  const user = await requireUser();

  const parsed = validate(confirmImportSchema, input);
  if (!parsed.ok) return parsed.result;

  const { csv, campaignId, expectedCount, fileName } = parsed.data;

  const analysis = analyzeLeadCsv(csv);
  const urls = analysis.prepared.map((p) => p.linkedinUrl);

  const existingRows =
    urls.length === 0
      ? []
      : await prisma.lead.findMany({
          where: { linkedinUrl: { in: urls } },
          select: { linkedinUrl: true, fullName: true, status: true },
        });

  const preview = buildImportPreview(
    analysis,
    existingRows.map((r) => ({
      linkedinUrl: r.linkedinUrl,
      fullName: r.fullName,
      status: r.status,
      campaignName: null,
    })),
  );

  if (preview.toCreate.length !== expectedCount) {
    return actionError(
      `The number of importable rows changed since the preview (${preview.toCreate.length} now, ` +
        `${expectedCount} when you confirmed). Nothing was imported - review the preview again.`,
    );
  }

  if (preview.toCreate.length === 0) {
    return actionError('There is nothing to import.');
  }

  if (campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) return actionError('The selected campaign no longer exists.');
  }

  const batchId = randomUUID();

  const result = await prisma.lead.createMany({
    data: preview.toCreate.map((row) => ({
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: row.fullName,
      linkedinUrl: row.linkedinUrl,
      publicIdentifier: row.publicIdentifier,
      sourceUrl: row.sourceUrl,
      company: row.company,
      jobTitle: row.jobTitle,
      location: row.location,
      notes: row.notes,
      campaignId: campaignId ?? null,
      importBatchId: batchId,
      status: 'PENDING' as const,
    })),
    skipDuplicates: true,
  });

  await logActivity({
    action: 'LEADS_IMPORTED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: campaignId ?? null,
    message: `Imported ${result.count} lead(s)${fileName ? ` from ${fileName}` : ''}.`,
    metadata: {
      batchId,
      fileName: fileName ?? null,
      created: result.count,
      skippedExisting: preview.alreadyInDatabase.length,
      skippedDuplicateInFile: analysis.duplicatesInFile.length,
      rejected: analysis.rejected.filter((r) => r.reason !== 'BLANK_ROW').length,
      totalRows: analysis.totalRows,
    },
  });

  revalidatePath('/leads');
  revalidatePath('/');
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);

  return actionOk(
    {
      created: result.count,
      skippedExisting: preview.alreadyInDatabase.length,
      skippedDuplicateInFile: analysis.duplicatesInFile.length,
      rejected: analysis.rejected.filter((r) => r.reason !== 'BLANK_ROW').length,
      batchId,
    },
    `Imported ${result.count} lead(s).`,
  );
}

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(createLeadSchema, input);
  if (!parsed.ok) return parsed.result;

  const normalized = normalizeLinkedInUrl(parsed.data.linkedinUrl);
  if (!normalized.ok) return actionError(normalized.message);

  const existing = await prisma.lead.findUnique({
    where: { linkedinUrl: normalized.url },
    select: { id: true, fullName: true },
  });
  if (existing) {
    return actionError(
      `That profile is already in the database as "${existing.fullName}". Leads are unique by profile URL.`,
    );
  }

  const name = splitFullName(
    parsed.data.fullName,
    parsed.data.firstName,
    parsed.data.lastName,
  );

  const lead = await prisma.lead.create({
    data: {
      fullName: name.fullName || normalized.publicIdentifier,
      firstName: name.firstName,
      lastName: name.lastName,
      linkedinUrl: normalized.url,
      publicIdentifier: normalized.publicIdentifier,
      sourceUrl: parsed.data.linkedinUrl,
      company: parsed.data.company ?? null,
      jobTitle: parsed.data.jobTitle ?? null,
      location: parsed.data.location ?? null,
      notes: parsed.data.notes ?? null,
      campaignId: parsed.data.campaignId ?? null,
    },
    select: { id: true },
  });

  await logActivity({
    action: 'LEADS_IMPORTED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    leadId: lead.id,
    campaignId: parsed.data.campaignId ?? null,
    message: `Added lead ${name.fullName} by hand.`,
  });

  revalidatePath('/leads');
  return actionOk({ id: lead.id }, 'Lead added.');
}

export async function updateLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(updateLeadSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, ...fields } = parsed.data;

  const existing = await prisma.lead.findUnique({
    where: { id },
    select: { id: true, status: true, fullName: true },
  });
  if (!existing) return actionError('Lead not found.');

  // Reassigning a lead that is mid-flight would race the worker.
  if (fields.campaignId !== undefined && existing.status === 'PROCESSING') {
    return actionError(
      'This lead is being processed right now. Wait for the current job to finish before moving it.',
    );
  }

  await prisma.lead.update({
    where: { id },
    data: {
      ...(fields.firstName !== undefined ? { firstName: fields.firstName } : {}),
      ...(fields.lastName !== undefined ? { lastName: fields.lastName } : {}),
      ...(fields.company !== undefined ? { company: fields.company } : {}),
      ...(fields.jobTitle !== undefined ? { jobTitle: fields.jobTitle } : {}),
      ...(fields.location !== undefined ? { location: fields.location } : {}),
      ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
      ...(fields.campaignId !== undefined ? { campaignId: fields.campaignId } : {}),
    },
  });

  await logActivity({
    action: 'LEAD_STATUS_CHANGED',
    result: 'INFO',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    leadId: id,
    message: `Edited lead ${existing.fullName}.`,
    metadata: { fields: Object.keys(fields) },
  });

  revalidatePath('/leads');
  revalidatePath(`/leads/${id}`);
  return actionOk({ id }, 'Lead updated.');
}

/**
 * Change a lead's status by hand.
 *
 * Refuses to set SENT manually: that status means "an invitation was confirmed
 * sent", and letting it be typed in would corrupt the duplicate guard and the
 * activity counts.
 */
export async function setLeadStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(setLeadStatusSchema, input);
  if (!parsed.ok) return parsed.result;

  const { id, status, reason } = parsed.data;

  if (status === 'SENT') {
    return actionError(
      'SENT cannot be set by hand - it records a verified invitation. Use SKIPPED or BLOCKED instead.',
    );
  }
  if (status === 'PROCESSING') {
    return actionError('PROCESSING is set by the worker when it claims a job.');
  }

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: { id: true, status: true, fullName: true, invitationSentAt: true },
  });
  if (!lead) return actionError('Lead not found.');

  if (lead.status === 'PROCESSING') {
    return actionError('This lead is being processed right now. Try again once the job finishes.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id },
      data: { status, lastResult: reason ? `Set by operator: ${reason}` : 'Set by operator' },
    });

    // Taking a lead out of play should also clear any queued work for it.
    if (status === 'SKIPPED' || status === 'BLOCKED') {
      await tx.queueJob.updateMany({
        where: { leadId: id, status: { in: ['WAITING', 'REQUIRES_REVIEW'] } },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          error: `Cancelled: lead set to ${status} by operator`,
        },
      });
    }

    await logActivity(
      {
        action: 'LEAD_STATUS_CHANGED',
        result: 'INFO',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        leadId: id,
        message: `Lead ${lead.fullName}: ${lead.status} -> ${status}${reason ? ` (${reason})` : ''}`,
      },
      tx,
    );
  });

  revalidatePath('/leads');
  revalidatePath('/');
  return actionOk({ id }, `Lead set to ${status}.`);
}

/**
 * Delete a lead.
 *
 * Refused once an invitation has been sent: deleting the row would destroy the
 * evidence that stops us contacting that person again.
 */
export async function deleteLead(leadId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, fullName: true, status: true, invitationSentAt: true },
  });
  if (!lead) return actionError('Lead not found.');

  if (lead.status === 'PROCESSING') {
    return actionError('This lead is being processed right now. Wait for the job to finish.');
  }
  if (lead.invitationSentAt) {
    return actionError(
      'This lead has already been sent an invitation. Deleting it would remove the record that ' +
        'prevents contacting them again. Set the status to BLOCKED instead.',
    );
  }

  await prisma.$transaction(async (tx) => {
    // Logged before deletion so the audit row can still reference the lead.
    await logActivity(
      {
        action: 'LEAD_DELETED',
        result: 'INFO',
        actorType: 'USER',
        actorId: user.id,
        actorName: user.name,
        leadId: lead.id,
        message: `Deleted lead ${lead.fullName}.`,
      },
      tx,
    );
    await tx.lead.delete({ where: { id: leadId } });
  });

  revalidatePath('/leads');
  return actionOk({ id: leadId }, 'Lead deleted.');
}
