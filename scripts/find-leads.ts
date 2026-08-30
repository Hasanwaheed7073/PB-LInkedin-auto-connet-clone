/**
 * Lead finder.
 *
 * Runs discovery providers, normalises what they return, deduplicates across
 * sources, scores each candidate against an ICP profile, and writes a ranked
 * CSV. Read-only against every source; it contacts nobody and opens no browser.
 *
 * Nothing is invented. A field the source did not state is left empty rather
 * than guessed, including names — a greeting rendered from a fabricated name is
 * worse than no greeting.
 *
 * Usage:
 *   npm run leads:find
 *   npm run leads:find -- --since 2026-06-01 --limit 800 --out found.csv
 *   npm run leads:find -- --icp icp/reverse-recruiting-jobseeker.json --band Hot,Warm
 *   npm run leads:find -- --calibrate       # band by percentile, not fixed cut-offs
 *   npm run leads:find -- --health
 */

import { writeFileSync, readFileSync } from 'node:fs';

import Papa from 'papaparse';

import {
  firstNameFromEmail,
  HackerNewsWantsHiredProvider,
} from '../src/engine/discovery/providers/hacker-news';
import { ClinicalTrialsGovProvider } from '../src/engine/discovery/providers/clinicaltrials-gov';
import { ExportImportProvider } from '../src/engine/discovery/providers/export-import';
import { WebSearchLinkedInProvider } from '../src/engine/discovery/providers/web-search';
import { isFailure, type DiscoveryProvider, type NormalizedCandidate } from '../src/engine/discovery/types';
import { scoreLead, HOME_SERVICES_OWNER_ICP, type IcpBand, type IcpProfile } from '../src/lib/icp';
import { normalizeLinkedInUrl } from '../src/lib/linkedin-url';

/**
 * Sources are selected per run. Nothing downstream branches on which one a
 * candidate came from - that is the whole point of the interface.
 */
function buildProviders(options: Options): DiscoveryProvider[] {
  const chosen: DiscoveryProvider[] = [];
  const want = (id: string) => !options.providers || options.providers.has(id);

  if (want('hn')) chosen.push(new HackerNewsWantsHiredProvider());
  if (want('search')) chosen.push(new WebSearchLinkedInProvider());
  if (want('ctgov')) chosen.push(new ClinicalTrialsGovProvider());
  for (const path of options.imports) chosen.push(new ExportImportProvider(path, 'phantombuster'));
  return chosen;
}

interface Options {
  since: Date | undefined;
  limit: number;
  outPath: string;
  icpPath: string | null;
  bands: Set<IcpBand> | null;
  health: boolean;
  /** Derive band cut-points from this run's distribution instead of the profile. */
  calibrate: boolean;
  /** Provider ids to run; null means all built-in ones. */
  providers: Set<string> | null;
  /** Export files to ingest through the import provider. */
  imports: string[];
  keywords: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    since: undefined,
    limit: 1_000,
    outPath: 'found-leads.csv',
    icpPath: null,
    bands: null,
    health: false,
    calibrate: false,
    providers: null,
    imports: [],
    keywords: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[(i += 1)] ?? '';
    if (arg === '--since') options.since = new Date(next());
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--out') options.outPath = next();
    else if (arg === '--icp') options.icpPath = next();
    else if (arg === '--health') options.health = true;
    else if (arg === '--calibrate') options.calibrate = true;
    else if (arg === '--import') options.imports.push(next());
    else if (arg === '--providers')
      options.providers = new Set(next().split(',').map((p) => p.trim()).filter(Boolean));
    else if (arg === '--keywords')
      options.keywords = next().split(',').map((k) => k.trim()).filter(Boolean);
    else if (arg === '--band')
      options.bands = new Set(
        next()
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean) as IcpBand[],
      );
  }
  return options;
}

/**
 * Identity keys, strongest first. Two candidates sharing any key are the same
 * person; their evidence is merged rather than producing two rows.
 */
function identityKeys(c: NormalizedCandidate): string[] {
  const keys: string[] = [];
  if (c.identity.email) keys.push(`email:${c.identity.email}`);
  const url = c.identity.linkedinUrl ? normalizeLinkedInUrl(c.identity.linkedinUrl) : null;
  if (url?.ok) keys.push(`linkedin:${url.url}`);
  if (c.identity.githubUrl) keys.push(`github:${c.identity.githubUrl.toLowerCase()}`);
  for (const handle of c.identity.handles) keys.push(`handle:${handle.toLowerCase()}`);
  return keys;
}

function ageInDays(published: Date | null, now: number): number | null {
  if (!published) return null;
  return Math.max(0, Math.round((now - published.getTime()) / 86_400_000));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const providers = buildProviders(options);

  if (options.health) {
    for (const provider of providers) {
      const health = await provider.health();
      process.stdout.write(
        `${health.ok ? 'OK  ' : 'FAIL'} ${provider.id.padEnd(28)} ${health.detail}\n`,
      );
    }
    return;
  }

  const profile: IcpProfile = options.icpPath
    ? (JSON.parse(readFileSync(options.icpPath, 'utf8')) as IcpProfile)
    : HOME_SERVICES_OWNER_ICP;

  const byKey = new Map<string, NormalizedCandidate>();
  const merged = new Map<NormalizedCandidate, Set<string>>();
  const stats = { raw: 0, rejected: 0, duplicates: 0, kept: 0 };
  const rejectionReasons = new Map<string, number>();
  const degraded: string[] = [];

  for (const provider of providers) {
    const budget = {
      maxRecords: options.limit,
      maxRequests: 40,
      deadline: new Date(now + 5 * 60_000),
    };

    process.stdout.write(`\nProvider: ${provider.id}\n`);

    try {
      for await (const raw of provider.search(
        { since: options.since, keywords: options.keywords },
        budget,
      )) {
        stats.raw += 1;
        const result = provider.normalize(raw);

        if (isFailure(result)) {
          stats.rejected += 1;
          rejectionReasons.set(result.reason, (rejectionReasons.get(result.reason) ?? 0) + 1);
          continue;
        }

        const keys = identityKeys(result);
        const existing = keys.map((k) => byKey.get(k)).find(Boolean);

        if (existing) {
          stats.duplicates += 1;
          // Merge evidence rather than dropping the second sighting.
          existing.signals.push(...result.signals);
          merged.get(existing)?.add(result.provenance.sourceUrl);
          for (const key of keys) if (!byKey.has(key)) byKey.set(key, existing);
          continue;
        }

        stats.kept += 1;
        merged.set(result, new Set([result.provenance.sourceUrl]));
        for (const key of keys) byKey.set(key, result);
      }
    } catch (error) {
      // One failing source degrades the run and names itself. It must never
      // look like the other sources simply found less today.
      degraded.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write(`  DEGRADED — ${degraded[degraded.length - 1]}\n`);
    }
  }

  const candidates = [...merged.keys()];

  const scored = candidates
    .map((c) => {
      const days = ageInDays(c.provenance.publishedAt, now);
      // Give the rule engine the freshness in words it can match on, alongside
      // everything the source stated. Rules read text, not dates.
      const freshness =
        days === null
          ? 'signal age unknown'
          : days <= 7
            ? `${days} days`
            : days <= 31
              ? '1 month'
              : days <= 62
                ? '2 months'
                : days <= 93
                  ? '3 months'
                  : `${Math.round(days / 30)} months`;

      const extra = [
        `posted: ${freshness}`,
        'signal: publicly asked to be hired',
        c.attributes.location && `location: ${c.attributes.location}`,
        c.attributes.remote && `remote: ${c.attributes.remote}`,
        c.attributes.willingToRelocate && `relocate: ${c.attributes.willingToRelocate}`,
        c.attributes.employmentType && `employment: ${c.attributes.employmentType}`,
        c.attributes.technologies && `technologies: ${c.attributes.technologies}`,
        c.attributes.summary,
      ]
        .filter(Boolean)
        .join('   ');

      const score = scoreLead(
        {
          fullName: c.identity.fullName,
          jobTitle: c.attributes.technologies,
          location: c.attributes.location,
          linkedinUrl: c.identity.linkedinUrl,
          extra,
        },
        profile,
      );

      return { candidate: c, score, days };
    })
    .sort((a, b) => b.score.rawScore - a.score.rawScore);

  // Fixed thresholds assume a score distribution that a single source rarely
  // produces. Every candidate here publicly asked to be hired, so the intent
  // rule fires on all of them and shifts the whole population up together -
  // which makes "Hot" mean nothing. Calibrating on percentiles makes a band
  // mean "the best available today", which is what a daily worklist needs.
  if (options.calibrate && scored.length >= 20) {
    const ranked = [...scored].sort((a, b) => b.score.rawScore - a.score.rawScore);
    const live = ranked.filter((s) => s.score.band !== 'Disqualified');
    const at = (fraction: number) =>
      live[Math.min(live.length - 1, Math.floor(live.length * fraction))]!.score.rawScore;
    const cuts = { hot: at(0.15), warm: at(0.4), cool: at(0.7) };

    for (const s of scored) {
      if (s.score.band === 'Disqualified') continue;
      const v = s.score.rawScore;
      s.score.band = v >= cuts.hot ? 'Hot' : v >= cuts.warm ? 'Warm' : v >= cuts.cool ? 'Cool' : 'Out';
    }
    process.stdout.write(
      `Bands calibrated on this run: Hot >= ${cuts.hot}, Warm >= ${cuts.warm}, Cool >= ${cuts.cool}\n`,
    );
  }

  let selected = scored.filter((s) => s.score.band !== 'Disqualified');
  if (options.bands) selected = selected.filter((s) => options.bands!.has(s.score.band));

  const rows = selected.map(({ candidate: c, score, days }) => ({
    score: score.score,
    band: score.band,
    ageDays: days ?? '',
    fullName: c.identity.fullName ?? '',
    firstNameGuess: c.identity.fullName ? '' : (firstNameFromEmail(c.identity.email) ?? ''),
    email: c.identity.email ?? '',
    linkedinUrl: c.identity.linkedinUrl ?? '',
    githubUrl: c.identity.githubUrl ?? '',
    location: c.attributes.location ?? '',
    remote: c.attributes.remote ?? '',
    employment: c.attributes.employmentType ?? '',
    technologies: c.attributes.technologies ?? '',
    resumeUrl: c.attributes.resumeUrl ?? '',
    handle: c.identity.handles[0] ?? '',
    sourceUrl: c.provenance.sourceUrl,
    publishedAt: c.provenance.publishedAt?.toISOString().slice(0, 10) ?? '',
    reasons: score.reasons.join('; '),
  }));

  writeFileSync(options.outPath, Papa.unparse(rows));

  const bandCounts = new Map<IcpBand, number>();
  for (const s of scored) bandCounts.set(s.score.band, (bandCounts.get(s.score.band) ?? 0) + 1);

  const withEmail = rows.filter((r) => r.email).length;
  const withLinkedIn = rows.filter((r) => r.linkedinUrl).length;
  const withEither = rows.filter((r) => r.email || r.linkedinUrl).length;

  const out = [
    '',
    `Discovered   : ${stats.raw} raw records`,
    `  rejected   : ${stats.rejected}`,
    `  duplicates : ${stats.duplicates} (merged, not dropped)`,
    `  people     : ${stats.kept}`,
    '',
    'Bands:',
    ...(['Hot', 'Warm', 'Cool', 'Out', 'Disqualified'] as IcpBand[]).map(
      (b) => `  ${b.padEnd(13)} ${String(bandCounts.get(b) ?? 0).padStart(5)}`,
    ),
    '',
    `Selected     : ${rows.length}`,
    `  with email : ${withEmail}`,
    `  with LinkedIn: ${withLinkedIn}`,
    `  contactable: ${withEither}${rows.length - withEither > 0 ? `  (${rows.length - withEither} with neither)` : ''}`,
    '',
  ];

  if (rejectionReasons.size > 0) {
    out.push('Rejections:');
    for (const [reason, count] of [...rejectionReasons].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(5)}  ${reason}`);
    }
    out.push('');
  }

  if (degraded.length > 0) {
    out.push('RUN DEGRADED — these sources failed and contributed nothing:');
    for (const d of degraded) out.push(`  ${d}`);
    out.push('');
  }

  out.push(`Wrote ${rows.length} row(s) to ${options.outPath}`);
  out.push('');
  process.stdout.write(out.join('\n'));
}

main().catch((error) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
