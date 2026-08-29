/**
 * Import a CSV of leads from the command line.
 *
 * Mirrors the dashboard's two-phase import exactly: the file is analysed, the
 * result is checked against what is already in the database, and the operator
 * sees precisely what would be written before anything is. The write itself
 * reuses the same rules - `createMany` with `skipDuplicates` over the unique
 * index on `linkedinUrl`, leads created as PENDING, one import batch id, and an
 * entry in the append-only activity log.
 *
 * Dry run by default. `--confirm` is the only thing that writes.
 *
 * Importing contacts nobody. Leads land as PENDING and stay there until a
 * campaign is created, a queue generated and the campaign explicitly activated
 * in the dashboard.
 *
 * Usage:
 *   npm run leads:import -- found-leads.csv
 *   npm run leads:import -- found-leads.csv --confirm
 *   npm run leads:import -- found-leads.csv --confirm --campaign <campaignId>
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { analyzeLeadCsv, buildImportPreview, summarizePreview } from '../src/lib/csv';
import { createPrismaClient } from '../src/lib/prisma-factory';

interface Options {
  file: string | null;
  confirm: boolean;
  campaignId: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { file: null, confirm: false, campaignId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--campaign') options.campaignId = argv[(i += 1)] ?? null;
    else if (!arg.startsWith('--')) options.file = arg;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    process.stderr.write('Usage: npm run leads:import -- <file.csv> [--confirm] [--campaign id]\n');
    process.exitCode = 1;
    return;
  }

  const prisma = createPrismaClient({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const csv = readFileSync(options.file, 'utf8');
    const analysis = analyzeLeadCsv(csv);
    const urls = analysis.prepared.map((p) => p.linkedinUrl);

    const existing =
      urls.length === 0
        ? []
        : await prisma.lead.findMany({
            where: { linkedinUrl: { in: urls } },
            select: { linkedinUrl: true, fullName: true, status: true },
          });

    const preview = buildImportPreview(
      analysis,
      existing.map((r) => ({
        linkedinUrl: r.linkedinUrl,
        fullName: r.fullName,
        status: r.status,
        campaignName: null,
      })),
    );
    const summary = summarizePreview(preview);

    const rejectedByReason = new Map<string, number>();
    for (const r of analysis.rejected) {
      if (r.reason === 'BLANK_ROW') continue;
      rejectedByReason.set(r.reason, (rejectedByReason.get(r.reason) ?? 0) + 1);
    }

    process.stdout.write(
      [
        '',
        `File            : ${options.file}`,
        `Rows in file    : ${summary.totalRows}`,
        `Will import     : ${summary.willImport}`,
        `Already in DB   : ${summary.alreadyInDatabase}`,
        `Duplicate in file: ${summary.duplicateInFile}`,
        `Invalid         : ${summary.invalid}`,
        '',
      ].join('\n'),
    );

    if (rejectedByReason.size > 0) {
      process.stdout.write('Rejections:\n');
      for (const [reason, count] of [...rejectedByReason].sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`  ${String(count).padStart(5)}  ${reason}\n`);
      }
      process.stdout.write('\n');
    }

    if (preview.toCreate.length > 0) {
      process.stdout.write('First 5 that would be created:\n');
      for (const row of preview.toCreate.slice(0, 5)) {
        process.stdout.write(`  ${row.fullName.padEnd(28)} ${row.linkedinUrl}\n`);
      }
      process.stdout.write('\n');
    }

    if (!options.confirm) {
      process.stdout.write('DRY RUN — nothing was written. Re-run with --confirm to import.\n\n');
      return;
    }

    if (preview.toCreate.length === 0) {
      process.stdout.write('Nothing to import.\n\n');
      return;
    }

    if (options.campaignId) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: options.campaignId },
        select: { id: true },
      });
      if (!campaign) throw new Error(`Campaign ${options.campaignId} does not exist.`);
    }

    // Attribute the write to the operator account, so the audit log names a
    // person rather than an anonymous process.
    const operator = await prisma.user.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, email: true },
    });

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
        campaignId: options.campaignId ?? null,
        importBatchId: batchId,
        status: 'PENDING' as const,
      })),
      skipDuplicates: true,
    });

    await prisma.activityLog.create({
      data: {
        action: 'LEADS_IMPORTED',
        result: 'SUCCESS',
        actorType: 'USER',
        actorId: operator?.id ?? null,
        actorName: operator?.name ?? 'CLI',
        campaignId: options.campaignId ?? null,
        message: `Imported ${result.count} lead(s) from ${options.file} via the CLI.`,
        metadata: {
          batchId,
          fileName: options.file,
          created: result.count,
          skippedExisting: preview.alreadyInDatabase.length,
          skippedDuplicateInFile: analysis.duplicatesInFile.length,
          rejected: analysis.rejected.filter((r) => r.reason !== 'BLANK_ROW').length,
          totalRows: analysis.totalRows,
          via: 'scripts/import-leads.ts',
        },
      },
    });

    process.stdout.write(
      `Imported ${result.count} lead(s). Batch ${batchId}.\n` +
        'They are PENDING. Nothing is contacted until a campaign is created and activated.\n\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
