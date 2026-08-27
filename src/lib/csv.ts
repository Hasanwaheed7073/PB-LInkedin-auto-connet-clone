import Papa from 'papaparse';

import {
  cleanPersonName,
  nameFromSlug,
  normalizeLinkedInUrl,
  splitFullName,
  type UrlRejectionReason,
} from './linkedin-url';

/**
 * CSV lead import.
 *
 * Pure analysis: this module never touches the database. It turns raw CSV text
 * into a fully-classified preview - valid rows, rejected rows with reasons, and
 * duplicates within the file itself. The server action then layers on
 * duplicate detection against existing leads and asks the operator to confirm
 * before a single row is written.
 */

/** Header aliases accepted for each field, compared after normalisation. */
const COLUMN_ALIASES = {
  linkedinUrl: [
    'linkedinurl',
    'linkedin',
    'linkedinprofile',
    'linkedinprofileurl',
    'profileurl',
    'profile',
    'url',
    'link',
    'publicprofileurl',
    'personlinkedinurl',
  ],
  firstName: ['firstname', 'first', 'givenname', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  fullName: ['fullname', 'name', 'displayname', 'contactname', 'person'],
  company: ['company', 'companyname', 'organization', 'organisation', 'employer', 'account'],
  jobTitle: ['jobtitle', 'title', 'position', 'role', 'headline', 'currenttitle'],
  location: ['location', 'city', 'region', 'country', 'geo', 'area'],
  notes: ['notes', 'note', 'comment', 'comments'],
} as const;

type FieldName = keyof typeof COLUMN_ALIASES;

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/^﻿/, '')
    .replace(/[^a-z0-9]/g, '');
}

export type ColumnMapping = Partial<Record<FieldName, string>>;

/**
 * Match CSV headers to fields. Returns the mapping plus the headers that were
 * not recognised, so the preview can tell the operator exactly which columns
 * are being ignored instead of silently dropping data.
 */
export function mapColumns(headers: string[]): {
  mapping: ColumnMapping;
  unmatchedHeaders: string[];
} {
  const mapping: ColumnMapping = {};
  const unmatchedHeaders: string[] = [];

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (normalized.length === 0) continue;

    let matched: FieldName | null = null;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
      FieldName,
      readonly string[],
    ][]) {
      if (aliases.includes(normalized)) {
        matched = field;
        break;
      }
    }

    // Only the first column claiming a field wins; later ones are reported.
    if (matched && mapping[matched] === undefined) {
      mapping[matched] = header;
    } else {
      unmatchedHeaders.push(header);
    }
  }

  return { mapping, unmatchedHeaders };
}

export interface PreparedLead {
  /** 1-based row number in the source file, counting the header as row 1. */
  rowNumber: number;
  linkedinUrl: string;
  publicIdentifier: string;
  sourceUrl: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  location: string | null;
  notes: string | null;
  /** True when no usable name column was present and the slug had to be used. */
  nameDerivedFromUrl: boolean;
}

export type RowRejectionReason =
  | UrlRejectionReason
  | 'NO_URL_COLUMN'
  | 'DUPLICATE_IN_FILE'
  | 'BLANK_ROW';

export interface RejectedRow {
  rowNumber: number;
  reason: RowRejectionReason;
  message: string;
  rawUrl: string;
  rawName: string;
  /** For DUPLICATE_IN_FILE: the earlier row this one collides with. */
  duplicateOfRow?: number;
}

export interface CsvAnalysis {
  /** Headers exactly as they appeared in the file. */
  headers: string[];
  mapping: ColumnMapping;
  unmatchedHeaders: string[];
  /** Data rows seen, excluding the header. */
  totalRows: number;
  /** Unique, valid, importable rows in file order. */
  prepared: PreparedLead[];
  rejected: RejectedRow[];
  /** Rows dropped because an earlier row in the same file had the same profile. */
  duplicatesInFile: RejectedRow[];
  /** Fatal parse problems reported by the CSV parser. */
  parseErrors: string[];
}

function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function optional(value: string | null | undefined, maxLength = 500): string | null {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

export const MAX_IMPORT_ROWS = 20_000;

/**
 * Parse and classify a CSV file. Never throws on malformed content - problems
 * come back as `parseErrors` or per-row rejections.
 */
export function analyzeLeadCsv(csvText: string): CsvAnalysis {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const parseErrors = parsed.errors
    // Papa reports a delimiter guess as an "error" on single-column files; it is not fatal.
    .filter((e) => e.code !== 'UndetectableDelimiter')
    .slice(0, 25)
    .map((e) => (e.row === undefined ? e.message : `Row ${e.row + 2}: ${e.message}`));

  const headers = (parsed.meta.fields ?? []).filter((h) => h.trim().length > 0);
  const { mapping, unmatchedHeaders } = mapColumns(headers);

  const analysis: CsvAnalysis = {
    headers,
    mapping,
    unmatchedHeaders,
    totalRows: parsed.data.length,
    prepared: [],
    rejected: [],
    duplicatesInFile: [],
    parseErrors,
  };

  if (!mapping.linkedinUrl) {
    analysis.rejected.push({
      rowNumber: 1,
      reason: 'NO_URL_COLUMN',
      message:
        'No LinkedIn URL column found. Expected a header such as "linkedinUrl", "Profile URL" or "LinkedIn".',
      rawUrl: '',
      rawName: '',
    });
    return analysis;
  }

  const seen = new Map<string, number>();
  const rowLimit = Math.min(parsed.data.length, MAX_IMPORT_ROWS);

  for (let i = 0; i < rowLimit; i += 1) {
    const row = parsed.data[i]!;
    const rowNumber = i + 2; // +1 for zero-index, +1 for the header row

    const rawUrl = firstNonEmpty(row[mapping.linkedinUrl]);
    const rawFull = mapping.fullName ? firstNonEmpty(row[mapping.fullName]) : '';
    const rawFirst = mapping.firstName ? firstNonEmpty(row[mapping.firstName]) : '';
    const rawLast = mapping.lastName ? firstNonEmpty(row[mapping.lastName]) : '';
    const rawName = firstNonEmpty(rawFull, `${rawFirst} ${rawLast}`.trim());

    const everyValueBlank = Object.values(row).every((v) => (v ?? '').trim().length === 0);
    if (everyValueBlank) {
      analysis.rejected.push({
        rowNumber,
        reason: 'BLANK_ROW',
        message: 'Row is empty',
        rawUrl,
        rawName,
      });
      continue;
    }

    const normalized = normalizeLinkedInUrl(rawUrl);
    if (!normalized.ok) {
      analysis.rejected.push({
        rowNumber,
        reason: normalized.reason,
        message: normalized.message,
        rawUrl,
        rawName,
      });
      continue;
    }

    const existingRow = seen.get(normalized.url);
    if (existingRow !== undefined) {
      const duplicate: RejectedRow = {
        rowNumber,
        reason: 'DUPLICATE_IN_FILE',
        message: `Same profile as row ${existingRow}`,
        rawUrl,
        rawName,
        duplicateOfRow: existingRow,
      };
      analysis.duplicatesInFile.push(duplicate);
      continue;
    }
    seen.set(normalized.url, rowNumber);

    const split = splitFullName(rawFull, rawFirst, rawLast);
    let { firstName, lastName, fullName } = split;
    let nameDerivedFromUrl = false;

    if (!fullName) {
      fullName = nameFromSlug(normalized.publicIdentifier);
      nameDerivedFromUrl = true;
      const fromSlug = splitFullName(fullName);
      firstName = fromSlug.firstName;
      lastName = fromSlug.lastName;
    }

    analysis.prepared.push({
      rowNumber,
      linkedinUrl: normalized.url,
      publicIdentifier: normalized.publicIdentifier,
      sourceUrl: rawUrl.slice(0, 1_000),
      fullName: fullName || nameFromSlug(normalized.publicIdentifier) || 'Unknown',
      firstName: firstName ? cleanPersonName(firstName).slice(0, 120) || null : null,
      lastName: lastName ? cleanPersonName(lastName).slice(0, 120) || null : null,
      company: mapping.company ? optional(row[mapping.company], 200) : null,
      jobTitle: mapping.jobTitle ? optional(row[mapping.jobTitle], 300) : null,
      location: mapping.location ? optional(row[mapping.location], 200) : null,
      notes: mapping.notes ? optional(row[mapping.notes], 2_000) : null,
      nameDerivedFromUrl,
    });
  }

  if (parsed.data.length > MAX_IMPORT_ROWS) {
    analysis.parseErrors.push(
      `File has ${parsed.data.length} rows; only the first ${MAX_IMPORT_ROWS} were analysed. Split the file and import in batches.`,
    );
  }

  return analysis;
}

export interface ExistingLeadRef {
  linkedinUrl: string;
  fullName: string;
  campaignName: string | null;
  status: string;
}

export interface ImportPreview {
  analysis: CsvAnalysis;
  /** Rows that will create a new lead. This is the number that gets imported. */
  toCreate: PreparedLead[];
  /** Rows whose profile already exists in the database. Never re-imported. */
  alreadyInDatabase: { row: PreparedLead; existing: ExistingLeadRef }[];
}

/**
 * Split analysed rows against leads that already exist.
 *
 * Existing leads are reported, never updated or re-created: an import must not
 * be able to resurrect a lead that was already contacted, reset its status, or
 * move it between campaigns behind the operator's back.
 */
export function buildImportPreview(
  analysis: CsvAnalysis,
  existing: ExistingLeadRef[],
): ImportPreview {
  const existingByUrl = new Map(existing.map((e) => [e.linkedinUrl, e]));

  const toCreate: PreparedLead[] = [];
  const alreadyInDatabase: { row: PreparedLead; existing: ExistingLeadRef }[] = [];

  for (const row of analysis.prepared) {
    const match = existingByUrl.get(row.linkedinUrl);
    if (match) {
      alreadyInDatabase.push({ row, existing: match });
    } else {
      toCreate.push(row);
    }
  }

  return { analysis, toCreate, alreadyInDatabase };
}

/** Counts rendered on the import preview screen. */
export interface ImportPreviewSummary {
  totalRows: number;
  willImport: number;
  duplicateInFile: number;
  alreadyInDatabase: number;
  invalid: number;
}

export function summarizePreview(preview: ImportPreview): ImportPreviewSummary {
  return {
    totalRows: preview.analysis.totalRows,
    willImport: preview.toCreate.length,
    duplicateInFile: preview.analysis.duplicatesInFile.length,
    alreadyInDatabase: preview.alreadyInDatabase.length,
    invalid: preview.analysis.rejected.filter((r) => r.reason !== 'BLANK_ROW').length,
  };
}
