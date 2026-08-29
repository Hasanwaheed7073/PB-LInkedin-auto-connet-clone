/**
 * ICP qualification for a lead export.
 *
 * Reads a CSV of any shape, scores every row against an ICP profile, ranks
 * them and writes a file the dashboard importer accepts. Pure analysis: it
 * never touches the database, never opens a browser and never contacts anyone.
 *
 * It deliberately scores rows that cannot be imported. A list with no profile
 * URLs is useless to the worker, but knowing that 180 of its 1,000 rows are
 * decision-makers tells you whether re-exporting it properly is worth the
 * afternoon.
 *
 * Usage:
 *   npm run leads:qualify -- <input.csv>
 *   npm run leads:qualify -- <input.csv> --out qualified.csv --band Hot,Warm
 *   npm run leads:qualify -- <input.csv> --icp ./my-icp.json --min 40
 *   npm run leads:qualify -- --init-icp ./my-icp.json      # write a starter profile
 */

import { readFileSync, writeFileSync } from 'node:fs';

import Papa from 'papaparse';

import { readCsvRecords } from '../src/lib/csv';
import { normalizeLinkedInUrl } from '../src/lib/linkedin-url';
import {
  HOME_SERVICES_OWNER_ICP,
  scoreLead,
  type IcpBand,
  type IcpProfile,
  type IcpScore,
} from '../src/lib/icp';

interface Options {
  input: string | null;
  icpPath: string | null;
  outPath: string;
  minScore: number | null;
  bands: Set<IcpBand> | null;
  top: number | null;
  initIcp: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    input: null,
    icpPath: null,
    outPath: 'qualified-leads.csv',
    minScore: null,
    bands: null,
    top: null,
    initIcp: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[(i += 1)] ?? '';

    if (arg === '--icp') options.icpPath = next();
    else if (arg === '--out') options.outPath = next();
    else if (arg === '--min') options.minScore = Number(next());
    else if (arg === '--top') options.top = Number(next());
    else if (arg === '--init-icp') options.initIcp = next();
    else if (arg === '--band')
      options.bands = new Set(
        next()
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean) as IcpBand[],
      );
    else if (!arg.startsWith('--')) options.input = arg;
  }

  return options;
}

function loadProfile(path: string | null): IcpProfile {
  if (!path) return HOME_SERVICES_OWNER_ICP;
  const profile = JSON.parse(readFileSync(path, 'utf8')) as IcpProfile;
  if (!Array.isArray(profile.rules) || profile.rules.length === 0) {
    throw new Error(`${path} has no rules - an ICP with no rules scores everything zero.`);
  }
  return profile;
}

interface Qualified {
  fileRow: number;
  fullName: string;
  jobTitle: string;
  company: string;
  location: string;
  linkedinUrl: string;
  score: IcpScore;
}

/** Bar of fixed width, so band distribution is readable at a glance. */
function bar(count: number, total: number, width = 28): string {
  if (total === 0) return '';
  return '█'.repeat(Math.max(count > 0 ? 1 : 0, Math.round((count / total) * width)));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.initIcp) {
    writeFileSync(options.initIcp, `${JSON.stringify(HOME_SERVICES_OWNER_ICP, null, 2)}\n`);
    process.stdout.write(
      `Wrote a starter ICP profile to ${options.initIcp}.\n` +
        'Edit the rules, then pass it with --icp.\n',
    );
    return;
  }

  if (!options.input) {
    process.stderr.write('Usage: npm run leads:qualify -- <input.csv> [--icp p] [--out p]\n');
    process.exitCode = 1;
    return;
  }

  const profile = loadProfile(options.icpPath);
  const csv = readFileSync(options.input, 'utf8');
  const { records, mapping, detection, headers } = readCsvRecords(csv);

  const get = (row: Record<string, string>, field: keyof typeof mapping): string => {
    const header = mapping[field];
    return header ? (row[header] ?? '').trim() : '';
  };

  const qualified: Qualified[] = records.map((row, index) => {
    const first = get(row, 'firstName');
    const last = get(row, 'lastName');
    const fullName = get(row, 'fullName') || `${first} ${last}`.trim();
    const rawUrl = get(row, 'linkedinUrl');
    const normalized = normalizeLinkedInUrl(rawUrl);

    const lead = {
      fullName,
      jobTitle: get(row, 'jobTitle'),
      company: get(row, 'company'),
      location: get(row, 'location'),
      linkedinUrl: normalized.ok ? normalized.url : '',
    };

    return {
      fileRow: index + 1,
      ...lead,
      score: scoreLead(lead, profile),
    };
  });

  // Highest score first; ties broken by row order so runs are reproducible.
  qualified.sort((a, b) => b.score.score - a.score.score || a.fileRow - b.fileRow);

  let selected = qualified.filter((q) => q.score.band !== 'Disqualified');
  if (options.bands) selected = selected.filter((q) => options.bands!.has(q.score.band));
  if (options.minScore !== null) selected = selected.filter((q) => q.score.score >= options.minScore!);
  if (options.top !== null) selected = selected.slice(0, options.top);

  const importable = selected.filter((q) => q.linkedinUrl.length > 0);

  const bands: IcpBand[] = ['Hot', 'Warm', 'Cool', 'Out', 'Disqualified'];
  const counts = new Map<IcpBand, number>(bands.map((b) => [b, 0]));
  for (const q of qualified) counts.set(q.score.band, (counts.get(q.score.band) ?? 0) + 1);

  const out: string[] = [];
  out.push('');
  out.push(`ICP profile : ${profile.name}`);
  out.push(`Source      : ${options.input}  (${records.length} rows)`);
  out.push(
    `Columns     : ${(['fullName', 'jobTitle', 'company', 'location', 'linkedinUrl'] as const)
      .map((f) => `${f}=${mapping[f] ?? '-'}`)
      .join('  ')}`,
  );
  if (detection.skippedLeadingRows > 0) {
    out.push(`              skipped ${detection.skippedLeadingRows} banner row(s) above the header`);
  }
  if (detection.urlColumnFoundByContent) {
    out.push(`              URL column "${detection.urlColumnFoundByContent}" found by its values`);
  }
  if (!mapping.jobTitle) {
    out.push(`              NO title/headline column (${headers.join(', ')}) - scores will be weak`);
  }
  out.push('');

  for (const band of bands) {
    const count = counts.get(band) ?? 0;
    out.push(`  ${band.padEnd(13)} ${String(count).padStart(5)}  ${bar(count, qualified.length)}`);
  }
  out.push('');

  const missingUrls = selected.length - importable.length;
  out.push(`Selected    : ${selected.length}`);
  out.push(`Importable  : ${importable.length}${missingUrls > 0 ? `  (${missingUrls} have no profile URL and cannot be imported)` : ''}`);
  out.push('');

  const preview = selected.slice(0, 10);
  if (preview.length > 0) {
    out.push('Top of the list:');
    for (const q of preview) {
      const name = (q.fullName || '(name from URL)').slice(0, 26).padEnd(26);
      const title = (q.jobTitle || '-').slice(0, 40).padEnd(40);
      out.push(`  ${String(q.score.score).padStart(4)}  ${q.score.band.padEnd(5)}  ${name} ${title}`);
      out.push(`        ${q.score.reasons.join('; ') || 'no rule matched'}`);
    }
    out.push('');
  }

  const rows = selected.map((q) => ({
    score: q.score.score,
    band: q.score.band,
    linkedinUrl: q.linkedinUrl,
    fullName: q.fullName,
    jobTitle: q.jobTitle,
    company: q.company,
    location: q.location,
    notes: q.score.reasons.join('; '),
    sourceRow: q.fileRow,
  }));

  writeFileSync(options.outPath, Papa.unparse(rows));
  out.push(`Wrote ${rows.length} row(s) to ${options.outPath}`);
  out.push(
    importable.length > 0
      ? 'Import it from Dashboard > Leads > Import CSV. Review the preview before confirming.'
      : 'Nothing here can be imported: no row carries a profile URL. Re-export the list with it included.',
  );
  out.push('');

  process.stdout.write(`${out.join('\n')}\n`);
}

main();
