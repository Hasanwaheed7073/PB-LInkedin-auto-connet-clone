/**
 * LinkedIn profile URL validation and normalisation.
 *
 * This module is the single source of truth for lead identity. Two CSV rows
 * refer to the same person if and only if they normalise to the same string,
 * and that string is stored in the globally-unique `leads.linkedinUrl` column.
 * Getting this wrong means either duplicate invitations or silently dropped
 * leads, so the rules are explicit and unit-tested.
 *
 * Canonical form: `https://www.linkedin.com/in/<slug>`
 *  - always https, always the `www` host (country subdomains such as
 *    `de.linkedin.com` serve the same profile)
 *  - no query string, no fragment, no trailing slash, no sub-paths
 *  - slug lower-cased: LinkedIn mints public identifiers in lower case and
 *    treats them case-insensitively, so folding case is what makes duplicate
 *    detection reliable
 *  - percent-escapes decoded then re-encoded uniformly, so `%C3%BC` and a
 *    literal `ü` collapse to one identity
 */

export const CANONICAL_PROFILE_PREFIX = 'https://www.linkedin.com/in/';

export type UrlRejectionReason =
  | 'EMPTY'
  | 'NOT_A_URL'
  | 'NOT_LINKEDIN'
  | 'NOT_A_PROFILE_URL'
  | 'COMPANY_PAGE'
  | 'SCHOOL_PAGE'
  | 'GROUP_PAGE'
  | 'SALES_NAVIGATOR'
  | 'DIRECTORY_PAGE'
  | 'MISSING_SLUG'
  | 'RESERVED_SLUG'
  | 'SLUG_TOO_LONG';

export type NormalizeResult =
  | { ok: true; url: string; publicIdentifier: string }
  | { ok: false; reason: UrlRejectionReason; message: string };

/**
 * Path segments that sit under `/in/` in LinkedIn's own routing and can never
 * be a person's public identifier.
 */
const RESERVED_SLUGS = new Set(['edit', 'me', 'unavailable', 'new']);

const LINKEDIN_HOST = /(^|\.)linkedin\.com$/i;

const REJECT_BY_FIRST_SEGMENT: Partial<Record<string, UrlRejectionReason>> = {
  company: 'COMPANY_PAGE',
  school: 'SCHOOL_PAGE',
  groups: 'GROUP_PAGE',
  sales: 'SALES_NAVIGATOR',
  talent: 'SALES_NAVIGATOR',
  recruiter: 'SALES_NAVIGATOR',
  pub: 'DIRECTORY_PAGE',
  directory: 'DIRECTORY_PAGE',
};

const MESSAGES: Record<UrlRejectionReason, string> = {
  EMPTY: 'No LinkedIn URL provided',
  NOT_A_URL: 'Not a parseable URL',
  NOT_LINKEDIN: 'Not a linkedin.com URL',
  NOT_A_PROFILE_URL: 'Not a personal profile URL (expected /in/<name>)',
  COMPANY_PAGE: 'This is a company page, not a person',
  SCHOOL_PAGE: 'This is a school page, not a person',
  GROUP_PAGE: 'This is a group page, not a person',
  SALES_NAVIGATOR:
    'Sales Navigator / Recruiter URLs do not identify a public profile. Export the public profile URL instead.',
  DIRECTORY_PAGE: 'This is a LinkedIn directory page, not a single profile',
  MISSING_SLUG: 'Profile URL has no public identifier after /in/',
  RESERVED_SLUG: 'That is a LinkedIn system page, not a person',
  SLUG_TOO_LONG: 'Public identifier is implausibly long',
};

function reject(reason: UrlRejectionReason): NormalizeResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/** Decode percent-escapes without throwing on malformed input. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Re-encode a decoded slug. `encodeURIComponent` leaves the characters that
 * legitimately appear in LinkedIn slugs (`-`, `_`, `.`, `~`) untouched and
 * escapes everything else consistently.
 */
function encodeSlug(value: string): string {
  return encodeURIComponent(value);
}

export function normalizeLinkedInUrl(input: string | null | undefined): NormalizeResult {
  const raw = (input ?? '').trim();
  if (raw.length === 0) return reject('EMPTY');

  // Accept bare hosts such as `linkedin.com/in/foo` and `www.linkedin.com/in/foo`
  // by supplying the scheme the CSV omitted.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return reject('NOT_A_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('NOT_A_URL');
  }
  if (!LINKEDIN_HOST.test(parsed.hostname)) {
    return reject('NOT_LINKEDIN');
  }

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return reject('NOT_A_PROFILE_URL');

  const first = safeDecode(segments[0]!).toLowerCase();

  const specificRejection = REJECT_BY_FIRST_SEGMENT[first];
  if (specificRejection) return reject(specificRejection);

  if (first !== 'in') return reject('NOT_A_PROFILE_URL');

  const rawSlug = segments[1];
  if (!rawSlug) return reject('MISSING_SLUG');

  const decoded = safeDecode(rawSlug).trim().toLowerCase();
  if (decoded.length === 0) return reject('MISSING_SLUG');
  if (RESERVED_SLUGS.has(decoded)) return reject('RESERVED_SLUG');
  if (decoded.length > 150) return reject('SLUG_TOO_LONG');

  const publicIdentifier = encodeSlug(decoded);

  return {
    ok: true,
    url: `${CANONICAL_PROFILE_PREFIX}${publicIdentifier}`,
    publicIdentifier,
  };
}

/** Convenience predicate for Zod refinements and UI validation. */
export function isValidLinkedInProfileUrl(input: string | null | undefined): boolean {
  return normalizeLinkedInUrl(input).ok;
}

/**
 * Build the URL the worker should navigate to.
 *
 * In tests, `mockBaseUrl` redirects navigation at a local fixture server so the
 * full worker path can be exercised without touching LinkedIn. In every other
 * environment the canonical linkedin.com URL is returned unchanged.
 */
export function profileNavigationUrl(canonicalUrl: string, mockBaseUrl?: string): string {
  if (!mockBaseUrl) return canonicalUrl;
  const slug = canonicalUrl.startsWith(CANONICAL_PROFILE_PREFIX)
    ? canonicalUrl.slice(CANONICAL_PROFILE_PREFIX.length)
    : canonicalUrl;
  return `${mockBaseUrl.replace(/\/$/, '')}/in/${slug}`;
}

// ---------------------------------------------------------------------------
// Name helpers (used by the CSV importer)
// ---------------------------------------------------------------------------

/**
 * Suffixes and credentials people append to their LinkedIn name field. Dropped
 * when deriving a last name so a rendered `{{lastName}}` does not read
 * "Smith, MBA, PMP".
 */
const NAME_NOISE =
  /\b(phd|ph\.d|md|m\.d|mba|msc|m\.sc|bsc|b\.sc|ma|ba|rn|cpa|pmp|cfa|esq|jr|sr|ii|iii|iv|acc|pcc|cscp|six sigma)\b\.?/gi;

/** Strip credential noise, emoji, and pronoun/decorative parentheticals. */
export function cleanPersonName(value: string): string {
  return value
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/\((?:[^)]*)\)/g, ' ')
    .replace(/[|·•]/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SplitName {
  firstName: string | null;
  lastName: string | null;
  fullName: string;
}

/**
 * Split a display name into first and last.
 *
 * Deliberately conservative: when the shape is ambiguous, the extra tokens are
 * folded into the last name rather than guessed at. Anything unusable returns
 * `null`, which lets the campaign setting `skipLeadsMissingTemplateVars` keep
 * a `{{firstName}}` template from rendering an empty greeting.
 */
export function splitFullName(
  rawFull: string | null | undefined,
  rawFirst?: string | null,
  rawLast?: string | null,
): SplitName {
  const explicitFirst = cleanPersonName(rawFirst ?? '');
  const explicitLast = cleanPersonName(rawLast ?? '');
  const cleanedFull = cleanPersonName(rawFull ?? '');

  if (explicitFirst || explicitLast) {
    const fullName = cleanedFull || [explicitFirst, explicitLast].filter(Boolean).join(' ');
    return {
      firstName: explicitFirst || null,
      lastName: explicitLast || null,
      fullName,
    };
  }

  if (!cleanedFull) {
    return { firstName: null, lastName: null, fullName: '' };
  }

  const tokens = cleanedFull.split(' ').filter(Boolean);
  if (tokens.length === 1) {
    return { firstName: tokens[0]!, lastName: null, fullName: cleanedFull };
  }

  return {
    firstName: tokens[0]!,
    lastName: tokens.slice(1).join(' '),
    fullName: cleanedFull,
  };
}

/** Last-resort display name derived from the URL slug, e.g. `john-smith-1a2` -> `John Smith`. */
export function nameFromSlug(publicIdentifier: string): string {
  const decoded = safeDecode(publicIdentifier);

  // Segments containing a digit are dropped: LinkedIn's uniqueness suffixes
  // always contain at least one digit, and names never do. Testing for "looks
  // like hex" instead would eat real names - `ada`, `bea`, `dee` and `cade` are
  // all valid hex strings.
  return decoded
    .split('-')
    .filter((part) => part.length > 0 && !/\d/.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .trim();
}
