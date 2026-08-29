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
  /** Fields filled by a partial header match rather than an exact alias. */
  fuzzyMatched: Partial<Record<FieldName, string>>;
} {
  const mapping: ColumnMapping = {};
  const unmatchedHeaders: string[] = [];

  // Position in a field's alias list is a preference, not a tie-break to be
  // decided by column order. A file with both "Headline" and "Job Title" must
  // map the title from "Job Title", whichever column comes first.
  const best: Partial<Record<FieldName, { header: string; rank: number }>> = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (normalized.length === 0) continue;

    let matched: FieldName | null = null;
    let rank = Number.MAX_SAFE_INTEGER;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
      FieldName,
      readonly string[],
    ][]) {
      const index = aliases.indexOf(normalized);
      if (index >= 0) {
        matched = field;
        rank = index;
        break;
      }
    }

    if (matched === null) {
      unmatchedHeaders.push(header);
      continue;
    }

    const incumbent = best[matched];
    if (!incumbent || rank < incumbent.rank) {
      if (incumbent) unmatchedHeaders.push(incumbent.header);
      best[matched] = { header, rank };
    } else {
      unmatchedHeaders.push(header);
    }
  }

  for (const [field, choice] of Object.entries(best) as [
    FieldName,
    { header: string; rank: number },
  ][]) {
    mapping[field] = choice.header;
  }

  // Nothing named a field exactly. Fall back to headers that merely contain an
  // alias - "Target Role(s)" for jobTitle, "Contact Full Name" for fullName.
  // Reported separately, because a partial match is a guess and the operator
  // is the one who can tell whether it is the right column.
  const fuzzyMatched: Partial<Record<FieldName, string>> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
    FieldName,
    readonly string[],
  ][]) {
    if (mapping[field] !== undefined) continue;

    let pick: { header: string; aliasLength: number } | null = null;
    for (const header of unmatchedHeaders) {
      const normalized = normalizeHeader(header);
      // Short aliases such as "gm" or "co" match far too much inside a longer
      // header, so only substantial ones are allowed to match partially.
      const hit = aliases.find((alias) => alias.length >= 4 && normalized.includes(alias));
      if (!hit) continue;
      if (!pick || hit.length > pick.aliasLength) pick = { header, aliasLength: hit.length };
    }

    if (pick) {
      mapping[field] = pick.header;
      fuzzyMatched[field] = pick.header;
      unmatchedHeaders.splice(unmatchedHeaders.indexOf(pick.header), 1);
    }
  }

  return { mapping, unmatchedHeaders, fuzzyMatched };
}

/**
 * How the file was interpreted before a single row was read.
 *
 * Every value here is shown to the operator. Guessing at a file's shape is
 * only acceptable if the guess is stated out loud - a silently chosen column
 * is how the wrong 600 people get invited.
 */
export interface DetectionNotes {
  /** 1-based position of the row used as the header, among non-empty rows. */
  headerRow: number;
  /** Rows above the header that were skipped as banner or title text. */
  skippedLeadingRows: number;
  /** True when no row looked like a header and synthetic names were used. */
  headerless: boolean;
  /**
   * Set to the column name when the profile URL column was identified by
   * looking at its values because no header matched a known alias.
   */
  urlColumnFoundByContent: string | null;
  /** Fields filled by a partial header match, as "field ← column" pairs. */
  fuzzyMatchedColumns: string[];
}

/** How many leading rows may be skipped while hunting for the header. */
const MAX_HEADER_SEARCH_ROWS = 25;

/** Rows sampled when identifying a column by its contents. */
const CONTENT_SAMPLE_ROWS = 200;

/**
 * Score a row's plausibility as the header: how many distinct fields its cells
 * name. A banner row ("100 Public U.S. Job-Seeker Leads") scores zero.
 */
function headerScore(cells: string[]): number {
  const matched = new Set<FieldName>();
  for (const cell of cells) {
    const normalized = normalizeHeader(cell);
    if (normalized.length === 0) continue;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
      FieldName,
      readonly string[],
    ][]) {
      if (aliases.includes(normalized)) matched.add(field);
    }
  }
  return matched.size;
}

/** True when a row carries at least one usable LinkedIn profile URL. */
function rowHasProfileUrl(cells: string[]): boolean {
  return cells.some((cell) => normalizeLinkedInUrl(cell).ok);
}

/**
 * Pick the header row. Exports routinely carry a title and a disclaimer above
 * the real header, and some files have no header at all.
 */
export function chooseHeaderRow(rows: string[][]): {
  headerIndex: number;
  headerless: boolean;
} {
  const limit = Math.min(rows.length, MAX_HEADER_SEARCH_ROWS);

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < limit; i += 1) {
    const score = headerScore(rows[i] ?? []);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex >= 0) return { headerIndex: bestIndex, headerless: false };

  // Nothing named a field. If the very first row already holds a profile URL it
  // is data, not a header, so keep it and invent column names.
  if (rows.length > 0 && rowHasProfileUrl(rows[0] ?? [])) {
    return { headerIndex: -1, headerless: true };
  }

  return { headerIndex: 0, headerless: false };
}

/**
 * Find the profile-URL column by inspecting values rather than headers, for
 * files whose column is called something unguessable.
 *
 * Requires a majority of a column's filled cells to be valid profile URLs, so
 * a notes column with one URL in it cannot win.
 */
export function findUrlColumnByContent(
  headers: string[],
  rows: Record<string, string>[],
): string | null {
  const sample = rows.slice(0, CONTENT_SAMPLE_ROWS);
  let best: { header: string; valid: number } | null = null;

  for (const header of headers) {
    let filled = 0;
    let valid = 0;
    for (const row of sample) {
      const value = (row[header] ?? '').trim();
      if (value.length === 0) continue;
      filled += 1;
      if (normalizeLinkedInUrl(value).ok) valid += 1;
    }
    if (valid === 0 || valid * 2 < filled) continue;
    if (!best || valid > best.valid) best = { header, valid };
  }

  return best?.header ?? null;
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
  /** What had to be inferred about the file's shape, for the operator to see. */
  detection: DetectionNotes;
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
export interface CsvRecords {
  headers: string[];
  records: Record<string, string>[];
  detection: DetectionNotes;
  mapping: ColumnMapping;
  unmatchedHeaders: string[];
  parseErrors: string[];
  /** File row number a data row came from, counting non-empty rows. */
  fileRowOf: (dataIndex: number) => number;
}

/**
 * Read a CSV of any shape into records plus a column mapping.
 *
 * Separate from `analyzeLeadCsv` because qualification wants to read a file
 * that the importer would reject: a list with no profile URLs is useless to
 * the worker but still worth scoring, to decide which rows justify the effort
 * of re-exporting them properly.
 */
export function readCsvRecords(csvText: string): CsvRecords {
  // Parsed without a header so the header row can be chosen deliberately:
  // exports often carry banner rows above it, and some files have none at all.
  const parsed = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: 'greedy',
  });

  const parseErrors = parsed.errors
    // Papa reports a delimiter guess as an "error" on single-column files; it is not fatal.
    .filter((e) => e.code !== 'UndetectableDelimiter')
    .slice(0, 25)
    .map((e) => (e.row === undefined ? e.message : `Row ${e.row + 1}: ${e.message}`));

  const rawRows = parsed.data.map((cells) =>
    (Array.isArray(cells) ? cells : []).map((c) => (c ?? '').toString().trim()),
  );

  const { headerIndex, headerless } = chooseHeaderRow(rawRows);
  const columnCount = rawRows.reduce((max, r) => Math.max(max, r.length), 0);

  const headers = headerless
    ? Array.from({ length: columnCount }, (_, i) => `column_${i + 1}`)
    : (rawRows[headerIndex] ?? []).map((h, i) => h.replace(/^﻿/, '') || `column_${i + 1}`);

  const dataRows = headerless ? rawRows : rawRows.slice(headerIndex + 1);

  /** The file row number a data row came from, counting non-empty rows. */
  const fileRowOf = (dataIndex: number) =>
    headerless ? dataIndex + 1 : headerIndex + dataIndex + 2;

  const records: Record<string, string>[] = dataRows.map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, i) => {
      record[header] = cells[i] ?? '';
    });
    return record;
  });

  const usableHeaders = headers.filter((h) => h.trim().length > 0);
  const { mapping, unmatchedHeaders, fuzzyMatched } = mapColumns(usableHeaders);

  const detection: DetectionNotes = {
    headerRow: headerless ? 0 : headerIndex + 1,
    skippedLeadingRows: headerless ? 0 : headerIndex,
    headerless,
    urlColumnFoundByContent: null,
    fuzzyMatchedColumns: Object.entries(fuzzyMatched).map(([f2, h]) => `${f2} ← ${h}`),
  };

  // Header names did not identify the URL column, so look at the values.
  if (!mapping.linkedinUrl) {
    const byContent = findUrlColumnByContent(usableHeaders, records);
    if (byContent) {
      mapping.linkedinUrl = byContent;
      detection.urlColumnFoundByContent = byContent;
      const ignoredAt = unmatchedHeaders.indexOf(byContent);
      if (ignoredAt >= 0) unmatchedHeaders.splice(ignoredAt, 1);
    }
  }

  return {
    headers: usableHeaders,
    records,
    detection,
    mapping,
    unmatchedHeaders,
    parseErrors,
    fileRowOf,
  };
}

export function analyzeLeadCsv(csvText: string): CsvAnalysis {
  const { headers: usableHeaders, records, detection, mapping, unmatchedHeaders, parseErrors, fileRowOf } =
    readCsvRecords(csvText);

  const analysis: CsvAnalysis = {
    headers: usableHeaders,
    detection,
    mapping,
    unmatchedHeaders,
    totalRows: records.length,
    prepared: [],
    rejected: [],
    duplicatesInFile: [],
    parseErrors,
  };

  if (!mapping.linkedinUrl) {
    const seenHeaders = usableHeaders.length > 0 ? usableHeaders.join(', ') : '(none)';
    analysis.rejected.push({
      rowNumber: Math.max(detection.headerRow, 1),
      reason: 'NO_URL_COLUMN',
      message:
        'No LinkedIn profile URL found in this file. Column headers were searched for names ' +
        'such as "linkedinUrl", "Profile URL" or "LinkedIn", and every column was then checked ' +
        `for profile URLs in its values. Columns seen: ${seenHeaders}. ` +
        'Re-export the list with the profile URL included - a lead cannot be identified without it.',
      rawUrl: '',
      rawName: '',
    });
    return analysis;
  }

  const seen = new Map<string, number>();
  const rowLimit = Math.min(records.length, MAX_IMPORT_ROWS);

  for (let i = 0; i < rowLimit; i += 1) {
    const row = records[i]!;
    const rowNumber = fileRowOf(i);

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

  if (records.length > MAX_IMPORT_ROWS) {
    analysis.parseErrors.push(
      `File has ${records.length} rows; only the first ${MAX_IMPORT_ROWS} were analysed. Split the file and import in batches.`,
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
