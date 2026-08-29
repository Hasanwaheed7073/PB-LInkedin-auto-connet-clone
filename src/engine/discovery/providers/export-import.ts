/**
 * Import provider for exports produced elsewhere — PhantomBuster, Sales
 * Navigator, Apollo, a VA with a spreadsheet.
 *
 * This is the bridge for LinkedIn-sourced data. Tools you already operate under
 * your own account can produce profile URLs; this pulls their output into the
 * same identity resolution, deduplication and scoring as every other source, so
 * a PhantomBuster row and a Hacker News post become one comparable lead.
 *
 * Reuses the shape-agnostic CSV reader, so it takes whatever column names the
 * exporting tool happened to use, including files with banner rows above the
 * header or no header at all.
 */

import { readFileSync } from 'node:fs';

import { readCsvRecords } from '../../../lib/csv';
import { normalizeLinkedInUrl } from '../../../lib/linkedin-url';
import type {
  Budget,
  DiscoveryCriteria,
  DiscoveryProvider,
  NormalizeResult,
  NormalizedCandidate,
  ProviderHealth,
  RawRecord,
} from '../types';

/**
 * Headline phrases that mark job-seeking intent.
 *
 * These come from real PhantomBuster exports, where the signal lives in the
 * headline rather than in a dedicated field: "Open for Work", "Open to work",
 * "#OpenToWork", "Seeking opportunities".
 */
const INTENT_PHRASES = [
  'open to work',
  'open for work',
  'opentowork',
  '#opentowork',
  'seeking opportunities',
  'seeking a new role',
  'actively seeking',
  'actively looking',
  'looking for opportunities',
  'looking for my next',
  'available for hire',
  'available immediately',
  'recently laid off',
  'laid off',
  'ex-',
];

const NEGATIVE_PHRASES = [
  'recruiter',
  'talent acquisition',
  'we are hiring',
  "we're hiring",
  'now hiring',
  'hiring manager',
  'headhunter',
  'staffing',
];

function containsAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  return needles.find((n) => lower.includes(n)) ?? null;
}

export class ExportImportProvider implements DiscoveryProvider {
  readonly id: string;
  readonly kind = 'import' as const;
  readonly compliance = {
    basis: 'user_submitted' as const,
    reference:
      'Operator-supplied export. The lawful basis is inherited from the tool that produced it ' +
      'and the account it was run under; this provider only reads the resulting file.',
    restrictions: [
      'Provenance is only as good as the source file. Record which tool produced it.',
      'A file with no profile URL cannot identify anyone — such rows are rejected, not guessed at.',
    ],
    reviewedAt: '2026-08-29',
  };

  constructor(
    private readonly filePath: string,
    /** Names the originating tool, so provenance survives the import. */
    private readonly sourceLabel = 'export',
  ) {
    this.id = `import_${sourceLabel.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const { records, mapping } = readCsvRecords(readFileSync(this.filePath, 'utf8'));
      return {
        ok: Boolean(mapping.linkedinUrl),
        detail: mapping.linkedinUrl
          ? `${records.length} rows, profile URL in "${mapping.linkedinUrl}"`
          : `${records.length} rows but NO profile URL column — re-export with it included`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
      };
    }
  }

  async *search(_criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord> {
    const { records, mapping, fileRowOf } = readCsvRecords(readFileSync(this.filePath, 'utf8'));

    let emitted = 0;
    for (let i = 0; i < records.length; i += 1) {
      if (emitted >= budget.maxRecords) return;
      emitted += 1;
      yield {
        externalId: `${this.id}:row${fileRowOf(i)}`,
        retrievedAt: new Date(),
        sourceUrl: this.filePath,
        payload: { row: records[i], mapping, sourceLabel: this.sourceLabel },
      };
    }
  }

  normalize(raw: RawRecord): NormalizeResult {
    const { row, mapping, sourceLabel } = raw.payload as {
      row: Record<string, string>;
      mapping: Record<string, string | undefined>;
      sourceLabel: string;
    };

    const value = (field: string): string => {
      const header = mapping[field];
      return header ? (row[header] ?? '').trim() : '';
    };

    const rawUrl = value('linkedinUrl');
    const normalized = rawUrl ? normalizeLinkedInUrl(rawUrl) : null;
    if (!normalized?.ok) {
      return {
        ok: false,
        reason: rawUrl
          ? `Unusable profile URL: ${normalized?.message ?? 'unknown'}`
          : 'Row has no profile URL — a lead cannot be identified without one',
        externalId: raw.externalId,
      };
    }

    // Everything the file says, so intent detection sees the headline even when
    // it lives in a column no alias would have guessed.
    const allText = Object.values(row).join(' ');
    const negative = containsAny(allText, NEGATIVE_PHRASES);
    if (negative) {
      return {
        ok: false,
        reason: `Hiring-side profile ("${negative}")`,
        externalId: raw.externalId,
      };
    }

    const intent = containsAny(allText, INTENT_PHRASES);
    const headline = value('jobTitle') || null;
    const first = value('firstName');
    const last = value('lastName');
    const fullName = value('fullName') || [first, last].filter(Boolean).join(' ') || null;

    const candidate: NormalizedCandidate = {
      identity: {
        fullName,
        email: null,
        linkedinUrl: normalized.url,
        githubUrl: null,
        website: null,
        handles: [`linkedin:${normalized.publicIdentifier}`],
      },
      attributes: {
        location: value('location') || null,
        remote: null,
        willingToRelocate: null,
        employmentType: null,
        technologies: headline,
        resumeUrl: null,
        summary: [headline, value('company'), value('notes')].filter(Boolean).join(' — ') || null,
      },
      signals: intent
        ? [
            {
              text: `${intent} — ${headline ?? ''}`.trim().slice(0, 600),
              sourceUrl: normalized.url,
              // Exports rarely date the signal. Leaving this null keeps a stale
              // headline from scoring as though it were posted this morning.
              publishedAt: null,
            },
          ]
        : [],
      provenance: {
        providerId: this.id,
        externalId: raw.externalId,
        sourceUrl: `${sourceLabel}:${raw.sourceUrl}`,
        retrievedAt: raw.retrievedAt,
        publishedAt: null,
      },
    };

    return candidate;
  }
}
