/**
 * LinkedIn profile discovery via a web-search API.
 *
 * This is the lawful route to the thing PhantomBuster gets by driving your
 * logged-in session: profile URLs of people showing job-seeking signals.
 *
 * The difference matters and is worth stating precisely. This provider queries
 * a search engine's paid API under its own terms and reads what the engine has
 * already indexed - the public profile title and snippet that LinkedIn itself
 * publishes to search engines. It never contacts linkedin.com, never
 * authenticates, never holds a session cookie, and never fetches a profile
 * page. There is no account to restrict, because no account is used.
 *
 * What that costs you, honestly: a snippet is perhaps 160 characters, so the
 * signal is thinner than a scraped profile, and index freshness lags reality by
 * days to weeks. What it buys: a source that cannot get your outreach account
 * banned, and that keeps working if LinkedIn tightens its controls tomorrow.
 *
 * Backends are interchangeable. Set one of:
 *   SERPER_API_KEY   - serper.dev
 *   BRAVE_API_KEY    - api.search.brave.com
 */

import type {
  Budget,
  DiscoveryCriteria,
  DiscoveryProvider,
  NormalizeResult,
  NormalizedCandidate,
  ProviderHealth,
  RawRecord,
} from '../types';

export interface SearchHit {
  title: string;
  link: string;
  snippet: string;
}

interface SearchBackend {
  readonly name: string;
  search(query: string, page: number): Promise<SearchHit[]>;
}

class SerperBackend implements SearchBackend {
  readonly name = 'serper';
  constructor(private readonly apiKey: string) {}

  async search(query: string, page: number): Promise<SearchHit[]> {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 100, page }),
    });
    if (!res.ok) throw new Error(`serper -> HTTP ${res.status}`);
    const data = (await res.json()) as { organic?: SearchHit[] };
    return data.organic ?? [];
  }
}

class BraveBackend implements SearchBackend {
  readonly name = 'brave';
  constructor(private readonly apiKey: string) {}

  async search(query: string, page: number): Promise<SearchHit[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '20');
    url.searchParams.set('offset', String(Math.max(0, page - 1)));
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`brave -> HTTP ${res.status}`);
    const data = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string }[] };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      link: r.url,
      snippet: r.description ?? '',
    }));
  }
}

export function resolveBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend | null {
  if (env.SERPER_API_KEY) return new SerperBackend(env.SERPER_API_KEY);
  if (env.BRAVE_API_KEY) return new BraveBackend(env.BRAVE_API_KEY);
  return null;
}

/**
 * Job-seeking phrasings that appear in a public profile headline or in the
 * opening of a post, which is all a search snippet ever contains.
 *
 * Deliberately phrase-based rather than a bare "open to work": the badge alone
 * is undated and often left on for months, while these are things someone
 * writes when they are actually searching.
 */
export const DEFAULT_SIGNAL_PHRASES = [
  '"open to work"',
  '"actively seeking"',
  '"actively looking for"',
  '"looking for my next role"',
  '"seeking new opportunities"',
  '"recently laid off"',
  '"impacted by layoffs"',
  '"available immediately"',
  '"open to new opportunities"',
];

/** Titles and phrases that mark the other side of the market. */
const NEGATIVE_SNIPPET = /\b(recruiter|talent acquisition|we'?re hiring|now hiring|hiring manager|headhunter|staffing)\b/i;

const PROFILE_URL = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i;

/**
 * LinkedIn renders result titles as "Name - Headline - Company | LinkedIn".
 * The name is the first segment; anything else is a headline fragment.
 */
export function parseResultTitle(title: string): { name: string | null; headline: string | null } {
  const withoutSuffix = title.replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '').trim();
  const parts = withoutSuffix.split(/\s+[-–|]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { name: null, headline: null };

  const candidate = parts[0]!;
  // A "name" containing a comma-and-role or too many words is a headline, not a name.
  const looksLikeName = /^[^,]{2,40}$/.test(candidate) && candidate.split(/\s+/).length <= 4;

  return {
    name: looksLikeName ? candidate : null,
    headline: parts.slice(looksLikeName ? 1 : 0).join(' — ') || null,
  };
}

export class WebSearchLinkedInProvider implements DiscoveryProvider {
  readonly id = 'web_search_linkedin';
  readonly kind = 'public_web' as const;
  readonly compliance = {
    basis: 'public_api_tos' as const,
    reference:
      'Search engine result API (serper.dev / api.search.brave.com) used under its own terms. ' +
      'Reads indexed public profile titles and snippets only; linkedin.com is never contacted.',
    restrictions: [
      'Snippets only. Do not fetch the profile page - that would be scraping LinkedIn.',
      'No authenticated LinkedIn access, no session cookie, no account involved.',
      'Index lag means a signal may be older than it appears; treat dates as unknown unless stated.',
    ],
    reviewedAt: '2026-08-29',
  };

  constructor(private readonly backend: SearchBackend | null = resolveBackend()) {}

  async health(): Promise<ProviderHealth> {
    if (!this.backend) {
      return {
        ok: false,
        detail: 'No search API key. Set SERPER_API_KEY or BRAVE_API_KEY in .env',
        checkedAt: new Date(),
      };
    }
    try {
      const hits = await this.backend.search('site:linkedin.com/in "open to work"', 1);
      return {
        ok: hits.length > 0,
        detail: `${this.backend.name}: ${hits.length} results for a probe query`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: `${this.backend.name}: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: new Date(),
      };
    }
  }

  async *search(criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord> {
    if (!this.backend) {
      throw new Error(
        'web_search_linkedin needs a search API key. Set SERPER_API_KEY or BRAVE_API_KEY.',
      );
    }

    const roleTerms = criteria.keywords?.length ? criteria.keywords : [''];
    const seen = new Set<string>();
    let requests = 0;
    let emitted = 0;

    for (const phrase of DEFAULT_SIGNAL_PHRASES) {
      for (const role of roleTerms) {
        for (let page = 1; page <= 3; page += 1) {
          if (emitted >= budget.maxRecords || requests >= budget.maxRequests) return;
          if (Date.now() > budget.deadline.getTime()) return;

          const query = `site:linkedin.com/in ${phrase}${role ? ` ${role}` : ''}`;
          const hits = await this.backend.search(query, page);
          requests += 1;
          if (hits.length === 0) break;

          for (const hit of hits) {
            const match = hit.link.match(PROFILE_URL)?.[0];
            if (!match) continue;
            const key = match.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            emitted += 1;
            yield {
              externalId: `linkedin:${key}`,
              retrievedAt: new Date(),
              sourceUrl: hit.link,
              payload: { hit, query, phrase },
            };
            if (emitted >= budget.maxRecords) return;
          }
        }
      }
    }
  }

  normalize(raw: RawRecord): NormalizeResult {
    const { hit, phrase } = raw.payload as { hit: SearchHit; phrase: string };
    const text = `${hit.title} ${hit.snippet}`.replace(/\s+/g, ' ').trim();

    if (NEGATIVE_SNIPPET.test(text)) {
      return {
        ok: false,
        reason: 'Snippet indicates a recruiter or hiring-side profile',
        externalId: raw.externalId,
      };
    }

    const url = hit.link.match(PROFILE_URL)?.[0];
    if (!url) {
      return { ok: false, reason: 'Not a personal profile URL', externalId: raw.externalId };
    }

    const { name, headline } = parseResultTitle(hit.title);

    const candidate: NormalizedCandidate = {
      identity: {
        fullName: name,
        email: null,
        linkedinUrl: url,
        githubUrl: null,
        website: null,
        handles: [],
      },
      attributes: {
        location: null,
        remote: null,
        willingToRelocate: null,
        employmentType: null,
        technologies: headline,
        resumeUrl: null,
        summary: hit.snippet || null,
      },
      signals: [
        {
          text: `${phrase.replace(/"/g, '')} — ${hit.snippet}`.slice(0, 600),
          sourceUrl: hit.link,
          // A search index carries no reliable publication date. Claiming one
          // would let stale signals score as fresh, which is the fastest way to
          // make the whole ranking dishonest.
          publishedAt: null,
        },
      ],
      provenance: {
        providerId: this.id,
        externalId: raw.externalId,
        sourceUrl: hit.link,
        retrievedAt: raw.retrievedAt,
        publishedAt: null,
      },
    };

    return candidate;
  }
}
