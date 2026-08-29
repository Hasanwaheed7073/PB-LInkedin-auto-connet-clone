import { describe, expect, it } from 'vitest';

import {
  parseResultTitle,
  resolveBackend,
  WebSearchLinkedInProvider,
  type SearchHit,
} from '@/engine/discovery/providers/web-search';
import { isFailure } from '@/engine/discovery/types';

/**
 * LinkedIn discovery through a search-engine API.
 *
 * The boundary being protected here: this provider reads what a search engine
 * has already indexed. It must never claim a publication date it cannot know,
 * and it must reject the hiring side of the market, which dominates results for
 * every job-related query.
 */

function makeRaw(hit: SearchHit, phrase = '"open to work"') {
  return {
    externalId: `linkedin:${hit.link.toLowerCase()}`,
    retrievedAt: new Date('2026-08-29T00:00:00Z'),
    sourceUrl: hit.link,
    payload: { hit, query: 'site:linkedin.com/in "open to work"', phrase },
  };
}

const provider = new WebSearchLinkedInProvider(null);

describe('parseResultTitle', () => {
  it('splits LinkedIn result titles into a name and a headline', () => {
    expect(parseResultTitle('Ada Lovelace - Senior Data Engineer - Acme | LinkedIn')).toEqual({
      name: 'Ada Lovelace',
      headline: 'Senior Data Engineer — Acme',
    });
  });

  it('does not treat a headline-first title as a name', () => {
    const parsed = parseResultTitle('Open to work, seeking Product roles | LinkedIn');
    expect(parsed.name).toBeNull();
    expect(parsed.headline).toContain('Open to work');
  });

  it('handles a title with no headline at all', () => {
    expect(parseResultTitle('Grace Hopper | LinkedIn')).toEqual({
      name: 'Grace Hopper',
      headline: null,
    });
  });
});

describe('resolveBackend', () => {
  it('returns null when no key is configured, rather than failing later', () => {
    expect(resolveBackend({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('prefers serper when both keys are present', () => {
    const backend = resolveBackend({
      SERPER_API_KEY: 'x',
      BRAVE_API_KEY: 'y',
    } as unknown as NodeJS.ProcessEnv);
    expect(backend?.name).toBe('serper');
  });
});

describe('WebSearchLinkedInProvider.normalize', () => {
  it('normalises a job-seeker result', () => {
    const result = provider.normalize(
      makeRaw({
        title: 'Ada Lovelace - Senior Data Engineer | LinkedIn',
        link: 'https://www.linkedin.com/in/ada-lovelace',
        snippet: 'Open to work. Senior data engineer, 9 years, seeking remote roles.',
      }),
    );

    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;
    expect(result.identity.linkedinUrl).toBe('https://www.linkedin.com/in/ada-lovelace');
    expect(result.identity.fullName).toBe('Ada Lovelace');
  });

  it('never claims a publication date, because a search index does not carry one', () => {
    const result = provider.normalize(
      makeRaw({
        title: 'Ada Lovelace | LinkedIn',
        link: 'https://www.linkedin.com/in/ada-lovelace',
        snippet: 'Open to work',
      }),
    );
    if (isFailure(result)) throw new Error('expected success');

    // Inventing a date here would let a two-year-old headline score as fresh.
    expect(result.signals[0]?.publishedAt).toBeNull();
    expect(result.provenance.publishedAt).toBeNull();
  });

  it('rejects recruiters, who dominate results for these queries', () => {
    for (const snippet of [
      'Technical Recruiter helping engineers find roles',
      "We're hiring across engineering",
      'Talent Acquisition Partner',
    ]) {
      const result = provider.normalize(
        makeRaw({
          title: 'Someone - Recruiter | LinkedIn',
          link: 'https://www.linkedin.com/in/someone',
          snippet,
        }),
      );
      expect(isFailure(result)).toBe(true);
    }
  });

  it('rejects company pages and other non-profile URLs', () => {
    const result = provider.normalize(
      makeRaw({
        title: 'Acme Corp | LinkedIn',
        link: 'https://www.linkedin.com/company/acme',
        snippet: 'Open to work',
      }),
    );
    expect(isFailure(result)).toBe(true);
  });

  it('refuses to run without a key rather than silently returning nothing', async () => {
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/SERPER_API_KEY|BRAVE_API_KEY/);
  });

  it('declares that it never contacts linkedin.com', () => {
    expect(provider.compliance.reference).toMatch(/linkedin\.com is never contacted/i);
    expect(provider.compliance.restrictions.join(' ')).toMatch(/no authenticated linkedin access/i);
  });
});
