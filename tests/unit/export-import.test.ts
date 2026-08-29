import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExportImportProvider } from '@/engine/discovery/providers/export-import';
import { isFailure } from '@/engine/discovery/types';

/**
 * Ingesting exports from tools operated elsewhere.
 *
 * The property under test: a row without a usable profile URL is rejected with
 * a reason, never filled in by inference. This is the provider most likely to
 * be handed a file with something missing.
 */

function fixture(csv: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'export-')), 'export.csv');
  writeFileSync(path, csv);
  return path;
}

async function collect(provider: ExportImportProvider) {
  const out = [];
  for await (const raw of provider.search(
    {},
    { maxRecords: 100, maxRequests: 10, deadline: new Date(Date.now() + 60_000) },
  )) {
    out.push(provider.normalize(raw));
  }
  return out;
}

describe('ExportImportProvider', () => {
  it('ingests a PhantomBuster-shaped export', async () => {
    const path = fixture(
      [
        'Status,Name,Headline,Company,Job Title,Industry,profileUrl',
        'Not invited yet,Kolby Barrett,Open for Work,Mad City,Field Marketing Manager,Construction,https://www.linkedin.com/in/kolby-barrett',
      ].join('\n'),
    );

    const [result] = await collect(new ExportImportProvider(path, 'phantombuster'));
    expect(result && isFailure(result)).toBe(false);
    if (!result || isFailure(result)) return;

    expect(result.identity.linkedinUrl).toBe('https://www.linkedin.com/in/kolby-barrett');
    expect(result.identity.fullName).toBe('Kolby Barrett');
    // "Open for Work" in a headline is the signal these exports actually carry.
    expect(result.signals[0]?.text).toContain('open for work');
  });

  it('rejects a row with no profile URL instead of inventing an identity', async () => {
    const path = fixture(['Name,Headline', 'Someone,Open to work'].join('\n'));
    const [result] = await collect(new ExportImportProvider(path));
    expect(result && isFailure(result)).toBe(true);
    if (result && isFailure(result)) expect(result.reason).toMatch(/no profile URL/i);
  });

  it('rejects recruiters found in any column', async () => {
    const path = fixture(
      [
        'Name,Headline,profileUrl',
        'Someone,Technical Recruiter at Acme,https://www.linkedin.com/in/someone',
      ].join('\n'),
    );
    const [result] = await collect(new ExportImportProvider(path));
    expect(result && isFailure(result)).toBe(true);
    if (result && isFailure(result)) expect(result.reason).toMatch(/hiring-side/i);
  });

  it('keeps a lead with no intent phrase, but records no signal for it', async () => {
    const path = fixture(
      ['Name,Headline,profileUrl', 'Someone,Data Engineer,https://www.linkedin.com/in/someone'].join(
        '\n',
      ),
    );
    const [result] = await collect(new ExportImportProvider(path));
    if (!result || isFailure(result)) throw new Error('expected success');
    expect(result.signals).toHaveLength(0);
  });

  it('never dates a signal an export did not date', async () => {
    const path = fixture(
      ['Name,Headline,profileUrl', 'Someone,Open to work,https://www.linkedin.com/in/someone'].join(
        '\n',
      ),
    );
    const [result] = await collect(new ExportImportProvider(path));
    if (!result || isFailure(result)) throw new Error('expected success');
    expect(result.signals[0]?.publishedAt).toBeNull();
  });

  it('reports a missing URL column in health rather than at row 700', async () => {
    const path = fixture(['Status,Name,Headline', 'Not invited yet,Someone,Open to work'].join('\n'));
    const health = await new ExportImportProvider(path).health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/NO profile URL column/i);
  });
});
