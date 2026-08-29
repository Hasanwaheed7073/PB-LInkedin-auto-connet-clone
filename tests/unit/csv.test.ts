import { describe, expect, it } from 'vitest';

import {
  analyzeLeadCsv,
  buildImportPreview,
  mapColumns,
  summarizePreview,
  type ExistingLeadRef,
} from '@/lib/csv';

/**
 * CSV import.
 *
 * The two properties that matter: nothing importable is silently dropped, and
 * nothing duplicate is silently created. Both directions are tested.
 */

describe('mapColumns', () => {
  it('recognises common header spellings', () => {
    const { mapping } = mapColumns([
      'First Name',
      'Last Name',
      'LinkedIn URL',
      'Company Name',
      'Job Title',
      'Location',
    ]);
    expect(mapping).toMatchObject({
      firstName: 'First Name',
      lastName: 'Last Name',
      linkedinUrl: 'LinkedIn URL',
      company: 'Company Name',
      jobTitle: 'Job Title',
      location: 'Location',
    });
  });

  it('recognises export-tool aliases', () => {
    const { mapping } = mapColumns(['profileUrl', 'fullName', 'organization', 'position']);
    expect(mapping).toMatchObject({
      linkedinUrl: 'profileUrl',
      fullName: 'fullName',
      company: 'organization',
      jobTitle: 'position',
    });
  });

  it('reports headers it does not understand instead of dropping them silently', () => {
    const { mapping, unmatchedHeaders } = mapColumns(['LinkedIn', 'Lead Score', 'Weird Column']);
    expect(mapping.linkedinUrl).toBe('LinkedIn');
    expect(unmatchedHeaders).toEqual(['Lead Score', 'Weird Column']);
  });

  it('does not let a second column steal a field already claimed', () => {
    const { mapping, unmatchedHeaders } = mapColumns(['url', 'linkedinUrl']);
    expect(mapping.linkedinUrl).toBe('url');
    expect(unmatchedHeaders).toContain('linkedinUrl');
  });
});

describe('analyzeLeadCsv', () => {
  it('parses a well-formed file', () => {
    const csv = [
      'firstName,lastName,linkedinUrl,company,jobTitle,location',
      'John,Smith,https://www.linkedin.com/in/john-smith,Acme,CRA,Berlin',
      'Sarah,Jones,https://www.linkedin.com/in/sarah-jones,Globex,CRC,London',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.totalRows).toBe(2);
    expect(analysis.prepared).toHaveLength(2);
    expect(analysis.rejected).toHaveLength(0);
    expect(analysis.prepared[0]).toMatchObject({
      rowNumber: 2,
      firstName: 'John',
      lastName: 'Smith',
      linkedinUrl: 'https://www.linkedin.com/in/john-smith',
      company: 'Acme',
      jobTitle: 'CRA',
      location: 'Berlin',
    });
  });

  it('reports a missing URL column rather than importing nothing quietly', () => {
    const analysis = analyzeLeadCsv('name,company\nJohn Smith,Acme');
    expect(analysis.prepared).toHaveLength(0);
    expect(analysis.rejected[0]?.reason).toBe('NO_URL_COLUMN');
  });

  it('removes duplicates within the file, keeping the first occurrence', () => {
    const csv = [
      'fullName,linkedinUrl',
      'John Smith,https://www.linkedin.com/in/john-smith',
      'John Smith Again,https://www.linkedin.com/in/john-smith/',
      'Johnny S,http://linkedin.com/in/JOHN-SMITH?trk=x',
      'Sarah Jones,https://www.linkedin.com/in/sarah-jones',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.prepared).toHaveLength(2);
    expect(analysis.duplicatesInFile).toHaveLength(2);
    expect(analysis.prepared[0]?.fullName).toBe('John Smith');
    expect(analysis.duplicatesInFile[0]).toMatchObject({
      rowNumber: 3,
      reason: 'DUPLICATE_IN_FILE',
      duplicateOfRow: 2,
    });
  });

  it('rejects invalid rows individually with a reason', () => {
    const csv = [
      'fullName,linkedinUrl',
      'Valid Person,https://www.linkedin.com/in/valid-person',
      'Company Page,https://www.linkedin.com/company/acme',
      'Not LinkedIn,https://twitter.com/someone',
      'No URL,',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.prepared).toHaveLength(1);
    const reasons = analysis.rejected.map((r) => r.reason);
    expect(reasons).toContain('COMPANY_PAGE');
    expect(reasons).toContain('NOT_LINKEDIN');
    expect(reasons).toContain('EMPTY');
  });

  it('derives a name from the slug when no name column is present', () => {
    const analysis = analyzeLeadCsv(
      'linkedinUrl\nhttps://www.linkedin.com/in/grace-hopper-1a2b3c',
    );
    expect(analysis.prepared[0]).toMatchObject({
      fullName: 'Grace Hopper',
      firstName: 'Grace',
      lastName: 'Hopper',
      nameDerivedFromUrl: true,
    });
  });

  it('handles a BOM, CRLF line endings and quoted fields containing commas', () => {
    const csv =
      '﻿fullName,linkedinUrl,jobTitle\r\n' +
      '"Smith, John",https://www.linkedin.com/in/john-smith,"CRA, Senior"\r\n';

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.prepared).toHaveLength(1);
    expect(analysis.prepared[0]?.jobTitle).toBe('CRA, Senior');
  });

  it('skips blank rows without counting them as invalid', () => {
    const csv = [
      'fullName,linkedinUrl',
      'John Smith,https://www.linkedin.com/in/john-smith',
      ',',
      '',
      'Sarah Jones,https://www.linkedin.com/in/sarah-jones',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);
    expect(analysis.prepared).toHaveLength(2);
    expect(analysis.rejected.filter((r) => r.reason !== 'BLANK_ROW')).toHaveLength(0);
  });

  it('retains the raw URL exactly as supplied for auditing', () => {
    const raw = 'https://de.linkedin.com/in/john-smith?originalSubdomain=de';
    const analysis = analyzeLeadCsv(`linkedinUrl\n${raw}`);
    expect(analysis.prepared[0]?.sourceUrl).toBe(raw);
    expect(analysis.prepared[0]?.linkedinUrl).toBe('https://www.linkedin.com/in/john-smith');
  });

  it('scales to a 600-lead list', () => {
    const rows = Array.from(
      { length: 600 },
      (_, i) => `Person ${i},https://www.linkedin.com/in/person-${i}`,
    );
    const analysis = analyzeLeadCsv(['fullName,linkedinUrl', ...rows].join('\n'));

    expect(analysis.totalRows).toBe(600);
    expect(analysis.prepared).toHaveLength(600);
    expect(analysis.rejected).toHaveLength(0);
    expect(new Set(analysis.prepared.map((p) => p.linkedinUrl)).size).toBe(600);
  });
});

describe('buildImportPreview', () => {
  const csv = [
    'fullName,linkedinUrl',
    'John Smith,https://www.linkedin.com/in/john-smith',
    'Sarah Jones,https://www.linkedin.com/in/sarah-jones',
    'New Person,https://www.linkedin.com/in/new-person',
  ].join('\n');

  const existing: ExistingLeadRef[] = [
    {
      linkedinUrl: 'https://www.linkedin.com/in/john-smith',
      fullName: 'John Smith',
      campaignName: 'Q3 CRA outreach',
      status: 'SENT',
    },
  ];

  it('splits rows into new and already-present', () => {
    const preview = buildImportPreview(analyzeLeadCsv(csv), existing);

    expect(preview.toCreate).toHaveLength(2);
    expect(preview.alreadyInDatabase).toHaveLength(1);
    expect(preview.alreadyInDatabase[0]?.existing.status).toBe('SENT');
    expect(preview.toCreate.map((r) => r.fullName)).toEqual(['Sarah Jones', 'New Person']);
  });

  it('never re-creates or resurrects an existing lead', () => {
    const preview = buildImportPreview(analyzeLeadCsv(csv), existing);
    const createdUrls = preview.toCreate.map((r) => r.linkedinUrl);
    expect(createdUrls).not.toContain('https://www.linkedin.com/in/john-smith');
  });

  it('summarises the counts shown on the preview screen', () => {
    const withDupes = [
      'fullName,linkedinUrl',
      'John Smith,https://www.linkedin.com/in/john-smith',
      'John Again,https://www.linkedin.com/in/john-smith',
      'Sarah Jones,https://www.linkedin.com/in/sarah-jones',
      'Bad Row,https://www.linkedin.com/company/acme',
    ].join('\n');

    const summary = summarizePreview(buildImportPreview(analyzeLeadCsv(withDupes), existing));

    expect(summary).toMatchObject({
      totalRows: 4,
      willImport: 1,
      duplicateInFile: 1,
      alreadyInDatabase: 1,
      invalid: 1,
    });
  });
});

/**
 * Files that are not shaped the way the importer would prefer.
 *
 * Real exports carry banner rows, unguessable column names, or no header at
 * all. Reading them is a convenience; inventing a profile URL is not, so the
 * last case here pins down that a file without URLs stays rejected.
 */
describe('awkward file shapes', () => {
  it('skips banner rows above the real header', () => {
    const csv = [
      '100 Public U.S. Job-Seeker Leads — Nationwide,,,',
      'Reconfirm availability before outreach.,,,',
      'Rank,Name,Public Profile URL,Notes',
      '1,Ada Lovelace,https://www.linkedin.com/in/ada-lovelace,Hot',
      '2,Alan Turing,https://www.linkedin.com/in/alan-turing,Warm',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.detection.headerRow).toBe(3);
    expect(analysis.detection.skippedLeadingRows).toBe(2);
    expect(analysis.prepared).toHaveLength(2);
    expect(analysis.prepared[0]).toMatchObject({
      rowNumber: 4,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      fullName: 'Ada Lovelace',
    });
  });

  it('finds the URL column by its values when the header name is unguessable', () => {
    const csv = [
      'ref,contact,where_they_live_online,segment',
      '1,Ada Lovelace,https://www.linkedin.com/in/ada-lovelace,A',
      '2,Alan Turing,linkedin.com/in/alan-turing,B',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.detection.urlColumnFoundByContent).toBe('where_they_live_online');
    expect(analysis.prepared.map((p) => p.linkedinUrl)).toEqual([
      'https://www.linkedin.com/in/ada-lovelace',
      'https://www.linkedin.com/in/alan-turing',
    ]);
    expect(analysis.unmatchedHeaders).not.toContain('where_they_live_online');
  });

  it('does not mistake a notes column holding one stray URL for the URL column', () => {
    const csv = [
      'person,remark',
      'Ada Lovelace,met at a conference',
      'Alan Turing,see https://www.linkedin.com/in/alan-turing',
      'Grace Hopper,referred by a colleague',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.detection.urlColumnFoundByContent).toBeNull();
    expect(analysis.rejected[0]?.reason).toBe('NO_URL_COLUMN');
  });

  it('reads a file with no header row at all', () => {
    const csv = [
      'https://www.linkedin.com/in/ada-lovelace,Ada Lovelace',
      'https://www.linkedin.com/in/alan-turing,Alan Turing',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.detection.headerless).toBe(true);
    expect(analysis.prepared).toHaveLength(2);
    expect(analysis.prepared[0]?.rowNumber).toBe(1);
  });

  it('rejects a file with no profile URL anywhere and names the columns it saw', () => {
    const csv = [
      'Status,Name,Headline,Company,Job Title,Industry',
      'Not sent yet,Ada Lovelace,,,Maintenance Technician,',
      'Not sent yet,Alan Turing,,,Comfort Advisor,',
    ].join('\n');

    const analysis = analyzeLeadCsv(csv);

    expect(analysis.prepared).toHaveLength(0);
    expect(analysis.rejected[0]?.reason).toBe('NO_URL_COLUMN');
    expect(analysis.rejected[0]?.message).toContain('Status, Name, Headline');
  });
});
