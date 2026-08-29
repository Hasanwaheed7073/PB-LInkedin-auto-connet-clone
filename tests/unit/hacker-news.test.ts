import { describe, expect, it } from 'vitest';

import {
  decodeHtml,
  extractEmail,
  extractField,
  extractName,
  firstNameFromEmail,
  inferEmployment,
  HackerNewsWantsHiredProvider,
} from '@/engine/discovery/providers/hacker-news';
import { isFailure } from '@/engine/discovery/types';

/**
 * The parser for "Ask HN: Who wants to be hired?".
 *
 * The property under test throughout: a field the post did not state comes back
 * null. Every one of these values ends up in outreach, and a confidently wrong
 * location or a greeting built from a mailbox name is worse than a blank.
 */

const REAL_SHAPE = [
  'Location: Berlin, Germany (UTC+1)',
  'Remote: Yes, worldwide',
  'Willing to relocate: No',
  'Technologies: Go, TypeScript, Postgres, Kubernetes',
  'Résumé/CV: https://example.com/cv.pdf',
  'Email: ada.lovelace@example.com',
  'Senior backend engineer, 9 years, looking for full-time remote work.',
].join('\n');

function makeRaw(text: string, id = '1') {
  return {
    externalId: `hn:${id}`,
    retrievedAt: new Date('2026-08-29T00:00:00Z'),
    sourceUrl: `https://news.ycombinator.com/item?id=${id}`,
    payload: {
      comment: {
        objectID: id,
        author: 'someuser',
        comment_text: text,
        created_at: '2026-08-03T09:00:00Z',
        story_id: 49156682,
      },
      threadTitle: 'Ask HN: Who wants to be hired? (August 2026)',
    },
  };
}

describe('decodeHtml', () => {
  it('recovers the words from HN entity-escaped markup', () => {
    expect(decodeHtml('Java 17&#x2F;21 &amp; Spring<p>Remote: Yes')).toBe(
      'Java 17/21 & Spring\nRemote: Yes',
    );
  });
});

describe('extractField', () => {
  it('reads a labelled field', () => {
    expect(extractField(REAL_SHAPE, ['location'])).toBe('Berlin, Germany (UTC+1)');
    expect(extractField(REAL_SHAPE, ['technologies'])).toBe('Go, TypeScript, Postgres, Kubernetes');
  });

  it('stops at the next label when several run together on one line', () => {
    // This is the common case in the real thread, and the reason the parser
    // cannot simply read to end-of-line.
    const runOn = 'Location: Lisbon Remote: Yes Technologies: Rust, Postgres';
    expect(extractField(runOn, ['location'])).toBe('Lisbon');
    expect(extractField(runOn, ['remote'])).toBe('Yes');
  });

  it('returns null for a label the post never used', () => {
    expect(extractField(REAL_SHAPE, ['salary'])).toBeNull();
  });

  it('does not match a label appearing mid-sentence', () => {
    expect(extractField('I would consider relocation for the right role.', ['location'])).toBeNull();
  });
});

describe('extractEmail', () => {
  it('finds a plain address', () => {
    expect(extractEmail('Email: ada@example.com')).toBe('ada@example.com');
  });

  it('recovers a deliberately obfuscated address', () => {
    expect(extractEmail('ada [at] example [dot] com')).toBe('ada@example.com');
  });

  it('strips trailing punctuation rather than keeping it in the address', () => {
    expect(extractEmail('reach me at ada@example.com.')).toBe('ada@example.com');
  });

  it('returns null when there is no address', () => {
    expect(extractEmail('Location: Berlin')).toBeNull();
  });
});

describe('extractName', () => {
  it('takes a name the person actually wrote', () => {
    expect(extractName("Hi, I'm Grace Hopper and I build compilers")).toBe('Grace Hopper');
  });

  it('returns null rather than inventing one', () => {
    expect(extractName(REAL_SHAPE)).toBeNull();
  });
});

describe('firstNameFromEmail', () => {
  it('derives a first name from a first.last address', () => {
    expect(firstNameFromEmail('ada.lovelace@example.com')).toBe('Ada');
    expect(firstNameFromEmail('grace_hopper@example.com')).toBe('Grace');
  });

  it('refuses a single-word local part, which is as likely to be a handle', () => {
    expect(firstNameFromEmail('zx9000@example.com')).toBeNull();
    expect(firstNameFromEmail('coder@example.com')).toBeNull();
  });

  it('refuses role mailboxes, which would greet someone as "Hello"', () => {
    expect(firstNameFromEmail('hello.there@example.com')).toBeNull();
    expect(firstNameFromEmail('jobs.inbox@example.com')).toBeNull();
  });

  it('returns null for no email', () => {
    expect(firstNameFromEmail(null)).toBeNull();
  });
});

describe('inferEmployment', () => {
  it('reads employment type from prose when the label is absent', () => {
    expect(inferEmployment('looking for full-time remote work')).toBe('full-time');
    expect(inferEmployment('open to contract or C2C')).toBe('contract');
  });

  it('reports both when the person is open to both', () => {
    expect(inferEmployment('full-time or freelance')).toBe('full-time; contract');
  });

  it('returns null when nothing is stated', () => {
    expect(inferEmployment('Location: Berlin')).toBeNull();
  });
});

describe('HackerNewsWantsHiredProvider.normalize', () => {
  const provider = new HackerNewsWantsHiredProvider();

  it('normalises a well-formed post', () => {
    const result = provider.normalize(makeRaw(REAL_SHAPE));
    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;

    expect(result.identity.email).toBe('ada.lovelace@example.com');
    expect(result.attributes.location).toBe('Berlin, Germany (UTC+1)');
    expect(result.attributes.employmentType).toBe('full-time');
    expect(result.identity.handles).toEqual(['hackernews:someuser']);
    expect(result.provenance.publishedAt?.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });

  it('keeps the verbatim text as the signal, dated by publication not discovery', () => {
    const result = provider.normalize(makeRaw(REAL_SHAPE));
    if (isFailure(result)) throw new Error('expected success');

    // published_at drives decay. Using retrievedAt would make every rediscovery
    // of a six-month-old post look fresh.
    expect(result.signals[0]?.publishedAt?.toISOString()).toBe('2026-08-03T09:00:00.000Z');
    expect(result.signals[0]?.text).toContain('Senior backend engineer');
  });

  it('rejects a reply that is conversation rather than a post', () => {
    const result = provider.normalize(
      makeRaw('Congratulations on the new role, that sounds like a great fit for you!'),
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/not a candidate post/i);
  });

  it('rejects a post too short to carry anything', () => {
    const result = provider.normalize(makeRaw('bump'));
    expect(isFailure(result)).toBe(true);
  });

  it('finds a LinkedIn URL anywhere in the text, not only behind a label', () => {
    const result = provider.normalize(
      makeRaw(`${REAL_SHAPE}\nmore about me at https://www.linkedin.com/in/ada-lovelace`),
    );
    if (isFailure(result)) throw new Error('expected success');
    expect(result.identity.linkedinUrl).toBe('https://www.linkedin.com/in/ada-lovelace');
  });

  it('declares a lawful basis, without which it could not be registered', () => {
    expect(provider.compliance.basis).toBe('public_api_tos');
    expect(provider.compliance.reference).toMatch(/^https?:\/\//);
  });
});
