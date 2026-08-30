import { describe, expect, it } from 'vitest';

import {
  ClinicalTrialsGovProvider,
  looksLikePerson,
  parseContactName,
} from '@/engine/discovery/providers/clinicaltrials-gov';
import { isFailure } from '@/engine/discovery/types';

/**
 * ClinicalTrials.gov study contacts.
 *
 * Two filters carry this provider, and both were written against what the live
 * registry actually returned: investigators must be excluded because they are
 * the wrong side of the site, and role names must be excluded because a lead
 * called "Site Public Contact" is a desk, not a person. That single string
 * accounted for 142 rows in the first real run.
 */

function makeRaw(contact: Record<string, unknown>, location?: Record<string, unknown>) {
  return {
    externalId: 'ctgov:NCT1:x',
    retrievedAt: new Date('2026-08-31T00:00:00Z'),
    sourceUrl: 'https://clinicaltrials.gov/study/NCT1',
    payload: {
      nctId: 'NCT1',
      contact,
      location: location ?? {
        facility: 'Upstate Medical University',
        city: 'Albany',
        state: 'New York',
        country: 'United States',
      },
      study: {
        protocolSection: {
          identificationModule: { nctId: 'NCT1', briefTitle: 'A study of something' },
          statusModule: { lastUpdatePostDateStruct: { date: '2026-08-20' } },
          sponsorCollaboratorsModule: { leadSponsor: { name: 'Upstate' } },
        },
      },
    },
  };
}

describe('parseContactName', () => {
  it('splits a name from its credentials', () => {
    expect(parseContactName('Charity Ruhl, LPN')).toMatchObject({
      name: 'Charity Ruhl',
      credentials: ['lpn'],
      isCoordinator: true,
      isInvestigator: false,
    });
  });

  it('treats a medical degree as decisive, whatever else follows', () => {
    const parsed = parseContactName('Pamela B Allen, MD, MSc');
    expect(parsed.isInvestigator).toBe(true);
  });

  it('handles a name with no credentials', () => {
    expect(parseContactName('Mary Andrews')).toMatchObject({
      name: 'Mary Andrews',
      credentials: [],
    });
  });
});

describe('looksLikePerson', () => {
  it('accepts real names', () => {
    for (const name of ['Suzan Bzdick', 'Perla M Adames Castillo', 'Beth A Lee']) {
      expect(looksLikePerson(name)).toBe(true);
    }
  });

  it('rejects a role in the name field', () => {
    // Every one of these appeared in the live registry.
    for (const name of [
      'Site Public Contact',
      'Study Coordinator',
      'Research Coordinator',
      'Clinical Research Team',
      'Site Lead',
    ]) {
      expect(looksLikePerson(name)).toBe(false);
    }
  });

  it('rejects names carrying an organisation word', () => {
    for (const name of ['Clinical Trials Information', 'Massachusetts General Hospital']) {
      expect(looksLikePerson(name)).toBe(false);
    }
  });

  it('cannot tell a company name from a person by shape alone', () => {
    // "Boehringer Ingelheim" is two capitalised words with no corporate
    // suffix. Nothing about its shape separates it from a person, which is why
    // normalize compares the contact against the sponsor instead.
    expect(looksLikePerson('Boehringer Ingelheim')).toBe(true);
  });

  it('keeps a person whose name contains one role-ish word', () => {
    // "Lead" is a surname as well as a job. Only an all-role name is refused.
    expect(looksLikePerson('Jennifer Lead')).toBe(true);
  });
});

describe('ClinicalTrialsGovProvider.normalize', () => {
  const provider = new ClinicalTrialsGovProvider();

  it('normalises a coordinator contact', () => {
    const result = provider.normalize(
      makeRaw({ name: 'Suzan Bzdick, RN, CCRC', role: 'CONTACT', email: 'BZ@upstate.edu' }),
    );
    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;

    expect(result.identity.fullName).toBe('Suzan Bzdick');
    expect(result.identity.email).toBe('bz@upstate.edu');
    expect(result.attributes.location).toBe('Albany, New York');
    expect(result.attributes.technologies).toContain('RN, CCRC');
    // No profile URL exists in this registry, and none is invented.
    expect(result.identity.linkedinUrl).toBeNull();
  });

  it('dates the signal from the registry update, not from retrieval', () => {
    const result = provider.normalize(makeRaw({ name: 'Mary Andrews, CCRP', role: 'CONTACT' }));
    if (isFailure(result)) throw new Error('expected success');
    expect(result.signals[0]?.publishedAt?.toISOString().slice(0, 10)).toBe('2026-08-20');
  });

  it('rejects principal and sub-investigators', () => {
    for (const role of ['PRINCIPAL_INVESTIGATOR', 'SUB_INVESTIGATOR']) {
      const result = provider.normalize(makeRaw({ name: 'Jane Roe, PhD', role }));
      expect(isFailure(result)).toBe(true);
    }
  });

  it('rejects anyone holding a medical degree', () => {
    const result = provider.normalize(makeRaw({ name: 'Holly Lindsay, MD', role: 'CONTACT' }));
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/investigator credential/i);
  });

  it('rejects a sponsor listed as its own contact', () => {
    const result = provider.normalize(
      {
        ...makeRaw({ name: 'Boehringer Ingelheim', role: 'CONTACT', email: 'ct@example.com' }),
        payload: {
          ...makeRaw({ name: 'Boehringer Ingelheim', role: 'CONTACT' }).payload,
          study: {
            protocolSection: {
              identificationModule: { nctId: 'NCT1', briefTitle: 'A study' },
              statusModule: { lastUpdatePostDateStruct: { date: '2026-08-20' } },
              sponsorCollaboratorsModule: { leadSponsor: { name: 'Boehringer Ingelheim' } },
            },
          },
        },
      },
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/sponsor or the site itself/i);
  });

  it('declares that this data was published for patient enquiries', () => {
    expect(provider.compliance.basis).toBe('public_record');
    expect(provider.compliance.restrictions.join(' ')).toMatch(/patients can enquire/i);
  });
});
