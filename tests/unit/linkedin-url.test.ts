import { describe, expect, it } from 'vitest';

import {
  cleanPersonName,
  isValidLinkedInProfileUrl,
  nameFromSlug,
  normalizeLinkedInUrl,
  profileNavigationUrl,
  splitFullName,
} from '@/lib/linkedin-url';

/**
 * URL normalisation is the identity function for a lead. If two rows for the
 * same person normalise differently we send a duplicate invitation, and if two
 * different people collide we silently drop one. Both are covered here.
 */

describe('normalizeLinkedInUrl - accepted forms', () => {
  const canonical = 'https://www.linkedin.com/in/john-smith';

  it.each([
    ['https://www.linkedin.com/in/john-smith'],
    ['https://www.linkedin.com/in/john-smith/'],
    ['http://www.linkedin.com/in/john-smith'],
    ['https://linkedin.com/in/john-smith'],
    ['www.linkedin.com/in/john-smith'],
    ['linkedin.com/in/john-smith'],
    ['  https://www.linkedin.com/in/john-smith  '],
    ['https://www.linkedin.com/in/john-smith?trk=public_profile'],
    ['https://www.linkedin.com/in/john-smith#experience'],
    ['https://www.linkedin.com/in/john-smith/detail/recent-activity/'],
    ['https://de.linkedin.com/in/john-smith'],
    ['https://uk.linkedin.com/in/john-smith?originalSubdomain=uk'],
    ['HTTPS://WWW.LINKEDIN.COM/IN/JOHN-SMITH'],
  ])('normalises %s', (input) => {
    const result = normalizeLinkedInUrl(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(canonical);
      expect(result.publicIdentifier).toBe('john-smith');
    }
  });

  it('keeps the trailing hash LinkedIn appends for uniqueness', () => {
    const result = normalizeLinkedInUrl('https://www.linkedin.com/in/jane-doe-1a2b3c4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.publicIdentifier).toBe('jane-doe-1a2b3c4');
  });

  it('collapses a percent-escaped and a literal unicode slug to one identity', () => {
    const escaped = normalizeLinkedInUrl('https://www.linkedin.com/in/j%C3%BCrgen-m%C3%BCller');
    const literal = normalizeLinkedInUrl('https://www.linkedin.com/in/jürgen-müller');
    expect(escaped.ok && literal.ok).toBe(true);
    if (escaped.ok && literal.ok) {
      expect(escaped.url).toBe(literal.url);
    }
  });

  it('treats differing case as the same person', () => {
    const a = normalizeLinkedInUrl('https://www.linkedin.com/in/John-Smith');
    const b = normalizeLinkedInUrl('https://www.linkedin.com/in/john-smith');
    expect(a.ok && b.ok && a.url === b.url).toBe(true);
  });

  it('does NOT collapse two genuinely different people', () => {
    const a = normalizeLinkedInUrl('https://www.linkedin.com/in/john-smith');
    const b = normalizeLinkedInUrl('https://www.linkedin.com/in/john-smith-2');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.url).not.toBe(b.url);
  });
});

describe('normalizeLinkedInUrl - rejected forms', () => {
  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['not a url at all', 'NOT_A_URL'],
    ['https://example.com/in/john-smith', 'NOT_LINKEDIN'],
    ['https://notlinkedin.com/in/john', 'NOT_LINKEDIN'],
    ['https://www.linkedin.com/company/acme', 'COMPANY_PAGE'],
    ['https://www.linkedin.com/school/mit', 'SCHOOL_PAGE'],
    ['https://www.linkedin.com/groups/12345', 'GROUP_PAGE'],
    ['https://www.linkedin.com/sales/lead/ABC123', 'SALES_NAVIGATOR'],
    ['https://www.linkedin.com/talent/profile/xyz', 'SALES_NAVIGATOR'],
    ['https://www.linkedin.com/pub/dir/John/Smith', 'DIRECTORY_PAGE'],
    ['https://www.linkedin.com/feed/', 'NOT_A_PROFILE_URL'],
    ['https://www.linkedin.com/', 'NOT_A_PROFILE_URL'],
    ['https://www.linkedin.com/in/', 'MISSING_SLUG'],
    ['https://www.linkedin.com/in/me', 'RESERVED_SLUG'],
    ['https://www.linkedin.com/in/edit', 'RESERVED_SLUG'],
    ['ftp://www.linkedin.com/in/john', 'NOT_A_URL'],
  ])('rejects %s with %s', (input, reason) => {
    const result = normalizeLinkedInUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('rejects an implausibly long slug', () => {
    const result = normalizeLinkedInUrl(`https://www.linkedin.com/in/${'a'.repeat(200)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SLUG_TOO_LONG');
  });

  it('exposes a predicate matching the full normaliser', () => {
    expect(isValidLinkedInProfileUrl('https://www.linkedin.com/in/x')).toBe(true);
    expect(isValidLinkedInProfileUrl('https://www.linkedin.com/company/x')).toBe(false);
    expect(isValidLinkedInProfileUrl(null)).toBe(false);
  });
});

describe('profileNavigationUrl', () => {
  it('returns the canonical LinkedIn URL when no mock base is given', () => {
    const url = 'https://www.linkedin.com/in/john-smith';
    expect(profileNavigationUrl(url)).toBe(url);
  });

  it('redirects at the fixture server when a mock base is given', () => {
    expect(
      profileNavigationUrl('https://www.linkedin.com/in/john-smith', 'http://127.0.0.1:4010'),
    ).toBe('http://127.0.0.1:4010/in/john-smith');
  });

  it('tolerates a trailing slash on the mock base', () => {
    expect(
      profileNavigationUrl('https://www.linkedin.com/in/john-smith', 'http://127.0.0.1:4010/'),
    ).toBe('http://127.0.0.1:4010/in/john-smith');
  });
});

describe('cleanPersonName', () => {
  it('strips credential noise', () => {
    expect(cleanPersonName('Jane Doe, PhD')).toBe('Jane Doe');
    expect(cleanPersonName('John Smith MBA')).toBe('John Smith');
    expect(cleanPersonName('Sarah Jones, CPA, PMP')).toBe('Sarah Jones');
  });

  it('strips emoji and parentheticals', () => {
    expect(cleanPersonName('Alex Ray (they/them) 🚀')).toBe('Alex Ray');
    expect(cleanPersonName('Maria Lopez | Hiring')).toBe('Maria Lopez Hiring');
  });

  it('leaves an ordinary name untouched', () => {
    expect(cleanPersonName('Ada Lovelace')).toBe('Ada Lovelace');
  });
});

describe('splitFullName', () => {
  it('prefers explicit first/last columns', () => {
    const result = splitFullName('Ignored Value', 'Grace', 'Hopper');
    expect(result.firstName).toBe('Grace');
    expect(result.lastName).toBe('Hopper');
  });

  it('splits a two-token full name', () => {
    const result = splitFullName('Grace Hopper');
    expect(result).toMatchObject({ firstName: 'Grace', lastName: 'Hopper' });
  });

  it('folds extra tokens into the last name rather than guessing a middle name', () => {
    const result = splitFullName('Jean Claude Van Damme');
    expect(result.firstName).toBe('Jean');
    expect(result.lastName).toBe('Claude Van Damme');
  });

  it('returns a null last name for a single token', () => {
    const result = splitFullName('Cher');
    expect(result).toMatchObject({ firstName: 'Cher', lastName: null });
  });

  it('returns nulls for unusable input so the campaign can skip the lead', () => {
    const result = splitFullName('   ');
    expect(result).toMatchObject({ firstName: null, lastName: null, fullName: '' });
  });
});

describe('nameFromSlug', () => {
  it('builds a display name and drops the uniqueness hash', () => {
    expect(nameFromSlug('john-smith-1a2b3c4')).toBe('John Smith');
  });

  it('handles a slug with no hash', () => {
    expect(nameFromSlug('ada-lovelace')).toBe('Ada Lovelace');
  });
});
