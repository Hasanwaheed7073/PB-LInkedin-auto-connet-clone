/**
 * Hacker News "Ask HN: Who wants to be hired?" discovery provider.
 *
 * Why this source before any other: the intent is not inferred, it is the
 * reason the person posted. Someone in that thread has publicly asked to be
 * hired, on a known date, and by convention has included their location,
 * availability, stack and an email address. There is no signal-detection
 * guesswork and no contactability problem.
 *
 * It is also the cleanest source legally available: a public, documented,
 * unauthenticated API, no terms to work around, no account to put at risk.
 *
 * Volume is roughly 400-600 posts per month, published as one thread on the
 * first working day of each month. That is a monthly batch, not a daily drip,
 * and the freshness scoring downstream should be told the truth about it.
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

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const THREAD_AUTHOR = 'whoishiring';
const WANTS_HIRED = /who wants to be hired/i;

interface AlgoliaStory {
  objectID: string;
  title: string;
  created_at: string;
  num_comments: number | null;
}

interface AlgoliaComment {
  objectID: string;
  author: string;
  comment_text: string | null;
  created_at: string;
  story_id: number;
}

/** HN serves HTML-escaped text with markup. Recover the words the person wrote. */
export function decodeHtml(input: string): string {
  return input
    .replace(/<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Pull a value from the thread's conventional `Label: value` format.
 *
 * The labels run together on one line as often as not, so a match ends at the
 * next known label rather than at a newline. Anchoring on newlines loses most
 * of the fields in practice.
 */
const FIELD_LABELS = [
  'location',
  'remote',
  'willing to relocate',
  'relocate',
  'employment',
  'employment type',
  'technologies',
  'tech',
  'skills',
  'résumé/cv',
  'resume/cv',
  'résumé',
  'resume',
  'cv',
  'email',
  'contact',
  'github',
  'linkedin',
  'website',
  'portfolio',
  'availability',
  'salary',
];

export function extractField(text: string, labels: string[]): string | null {
  const others = FIELD_LABELS.filter((l) => !labels.includes(l))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?:^|[\\n\\s])${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n|\\s(?:${others})\\s*:|$)`,
      'i',
    );
    const match = text.match(re);
    const value = match?.[1]?.trim().replace(/\s+/g, ' ');
    if (value) return value.slice(0, 400);
  }
  return null;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Obfuscated addresses are common in these threads and are still consented contact. */
export function extractEmail(text: string): string | null {
  const direct = text.match(EMAIL_RE)?.[0];
  if (direct) return direct.toLowerCase().replace(/[.,;:]+$/, '');

  const obfuscated = text
    .replace(/\s*\[?\s*(?:at|@)\s*\]?\s*/gi, '@')
    .replace(/\s*\[?\s*(?:dot|\.)\s*\]?\s*/gi, '.');
  const recovered = obfuscated.match(EMAIL_RE)?.[0];
  return recovered ? recovered.toLowerCase().replace(/[.,;:]+$/, '') : null;
}

function findUrl(text: string, host: RegExp): string | null {
  const urls = text.match(URL_RE) ?? [];
  return urls.find((u) => host.test(u))?.replace(/[.,;:)\]]+$/, '') ?? null;
}

/**
 * A name is only taken when the person actually wrote one. HN handles are not
 * names, and inventing one from a handle would be fabricating a field —
 * exactly what the outreach templates then render into a greeting.
 */
export function extractName(text: string): string | null {
  const patterns = [
    /(?:^|\n)\s*(?:name|my name is|this is)\s*:?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){0,2})/,
    /^([A-Z][a-z]+\s+[A-Z][a-z'’-]+)\s*[—–|-]\s/,
    /(?:^|\n)\s*(?:hi|hello|hey)[,!]?\s+(?:there[,!]?\s+)?(?:i'?m|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+)?)/i,
    /(?:^|\n)\s*i'?m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+)?)\s*[,.]/,
  ];
  for (const re of patterns) {
    const found = text.match(re)?.[1]?.trim();
    if (found && found.length <= 60) return found;
  }
  return null;
}

/** Local parts that are a mailbox purpose, not a person. */
const ROLE_ACCOUNTS = new Set([
  'info', 'hello', 'hi', 'contact', 'jobs', 'work', 'me', 'mail', 'email',
  'admin', 'careers', 'hire', 'hireme', 'dev', 'team', 'support', 'resume', 'cv',
]);

/**
 * A first name inferred from an email local part, or null.
 *
 * Kept deliberately out of `fullName`: this is an inference, not something the
 * person wrote, so it is surfaced in its own column where nobody can mistake it
 * for stated fact. Only `first.last` and `first_last` shapes are accepted — a
 * single-word local part is as likely to be a handle as a name, and greeting a
 * stranger by their handle is worse than not greeting them at all.
 */
export function firstNameFromEmail(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0] ?? '';
  const match = local.match(/^([a-z]{2,})[._]([a-z]{2,})/i);
  if (!match) return null;
  const first = match[1]!.toLowerCase();
  if (ROLE_ACCOUNTS.has(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Employment type as stated in prose.
 *
 * `Employment:` is not part of this thread's convention — it appears in well
 * under 1% of posts — so the labelled field is almost always absent and the
 * words have to carry it.
 */
export function inferEmployment(text: string): string | null {
  const found: string[] = [];
  if (/\b(full[- ]?time|fte|w2|permanent)\b/i.test(text)) found.push('full-time');
  if (/\b(contract|contracting|c2c|corp[- ]to[- ]corp|1099|freelance|consulting)\b/i.test(text))
    found.push('contract');
  if (/\bpart[- ]?time\b/i.test(text)) found.push('part-time');
  if (/\bintern(ship)?\b/i.test(text)) found.push('internship');
  return found.length > 0 ? found.join('; ') : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'lead-intelligence/0.1' },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class HackerNewsWantsHiredProvider implements DiscoveryProvider {
  readonly id = 'hacker_news_wants_hired';
  readonly kind = 'public_web' as const;
  readonly compliance = {
    basis: 'public_api_tos' as const,
    reference: 'https://hn.algolia.com/api — public, unauthenticated, documented search API',
    restrictions: [
      'People posted asking to be contacted about work. Contact them about work, not about anything else.',
      'Rate limited by courtesy: sequential requests, no parallel fan-out.',
    ],
    reviewedAt: '2026-08-29',
  };

  async health(): Promise<ProviderHealth> {
    try {
      const data = await fetchJson<{ hits: AlgoliaStory[] }>(
        `${ALGOLIA}/search_by_date?tags=story,author_${THREAD_AUTHOR}&hitsPerPage=1`,
      );
      return {
        ok: data.hits.length > 0,
        detail: data.hits[0]?.title ?? 'no threads returned',
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

  /** The monthly threads, newest first, that are asking who wants to be hired. */
  private async threads(since?: Date): Promise<AlgoliaStory[]> {
    const data = await fetchJson<{ hits: AlgoliaStory[] }>(
      `${ALGOLIA}/search_by_date?tags=story,author_${THREAD_AUTHOR}&hitsPerPage=24`,
    );
    return data.hits
      .filter((h) => WANTS_HIRED.test(h.title))
      .filter((h) => !since || new Date(h.created_at) >= since);
  }

  async *search(criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord> {
    let requests = 1;
    let emitted = 0;

    for (const thread of await this.threads(criteria.since)) {
      if (emitted >= budget.maxRecords || requests >= budget.maxRequests) return;
      if (Date.now() > budget.deadline.getTime()) return;

      // Algolia caps a page at 1000; a thread has never come close.
      const page = await fetchJson<{ hits: AlgoliaComment[] }>(
        `${ALGOLIA}/search?tags=comment,story_${thread.objectID}&hitsPerPage=1000`,
      );
      requests += 1;

      for (const comment of page.hits) {
        if (emitted >= budget.maxRecords) return;
        // Replies to other posts are conversation, not applications.
        if (String(comment.story_id) !== thread.objectID) continue;
        if (!comment.comment_text) continue;

        emitted += 1;
        yield {
          externalId: `hn:${comment.objectID}`,
          retrievedAt: new Date(),
          sourceUrl: `https://news.ycombinator.com/item?id=${comment.objectID}`,
          payload: { comment, threadTitle: thread.title },
        };
      }
    }
  }

  normalize(raw: RawRecord): NormalizeResult {
    const { comment } = raw.payload as { comment: AlgoliaComment };
    const text = decodeHtml(comment.comment_text ?? '');

    if (text.length < 40) {
      return { ok: false, reason: 'Comment too short to be a post', externalId: raw.externalId };
    }

    const email = extractEmail(extractField(text, ['email', 'contact']) ?? text);
    const linkedinUrl = findUrl(text, /linkedin\.com/i);
    const githubUrl = findUrl(text, /github\.com/i);
    const location = extractField(text, ['location']);

    // A post with neither a location nor a stated way to reach them is almost
    // always someone replying to a thread rather than posting to it.
    if (!location && !email && !linkedinUrl) {
      return {
        ok: false,
        reason: 'No location and no contact route — not a candidate post',
        externalId: raw.externalId,
      };
    }

    const publishedAt = new Date(comment.created_at);

    const candidate: NormalizedCandidate = {
      identity: {
        fullName: extractName(text),
        email,
        linkedinUrl,
        githubUrl,
        website: findUrl(text, /^(?!.*(?:linkedin|github)\.com).*$/i),
        handles: [`hackernews:${comment.author}`],
      },
      attributes: {
        location,
        remote: extractField(text, ['remote']),
        willingToRelocate: extractField(text, ['willing to relocate', 'relocate']),
        employmentType:
          extractField(text, ['employment', 'employment type', 'availability']) ??
          inferEmployment(text),
        technologies: extractField(text, ['technologies', 'tech', 'skills']),
        resumeUrl:
          findUrl(extractField(text, ['résumé/cv', 'resume/cv', 'résumé', 'resume', 'cv']) ?? '', /./) ??
          null,
        summary: text.slice(0, 1_000),
      },
      signals: [
        {
          // The thread title is the intent. They answered "who wants to be hired?".
          text: text.slice(0, 600),
          sourceUrl: raw.sourceUrl,
          publishedAt,
        },
      ],
      provenance: {
        providerId: this.id,
        externalId: raw.externalId,
        sourceUrl: raw.sourceUrl,
        retrievedAt: raw.retrievedAt,
        publishedAt,
      },
    };

    return candidate;
  }
}
