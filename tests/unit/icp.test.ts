import { describe, expect, it } from 'vitest';

import { HOME_SERVICES_OWNER_ICP, scoreLead, type IcpProfile } from '@/lib/icp';

/**
 * ICP scoring.
 *
 * The property that matters: a score is only useful if the reason for it is
 * inspectable and if near-miss titles do not quietly collect points they have
 * not earned.
 */

const icp = HOME_SERVICES_OWNER_ICP;

describe('scoreLead', () => {
  it('ranks an owner in the target industry as Hot', () => {
    const result = scoreLead(
      { fullName: 'A Person', jobTitle: 'Owner', company: 'Reliable HVAC LLC' },
      icp,
    );

    expect(result.band).toBe('Hot');
    expect(result.reasons.join(' ')).toContain('owner or principal');
    expect(result.reasons.join(' ')).toContain('target industry');
  });

  it('disqualifies a field technician however good the rest of the row looks', () => {
    const result = scoreLead(
      { fullName: 'A Person', jobTitle: 'HVAC Service Technician', company: 'Reliable HVAC LLC' },
      icp,
    );

    expect(result.band).toBe('Disqualified');
    expect(result.score).toBe(0);
    expect(result.disqualifiedBy).toBe('field or support role, cannot buy');
  });

  it('does not count a vice president as an owner', () => {
    const vp = scoreLead({ jobTitle: 'Vice President, Marketing & Sales' }, icp);

    expect(vp.reasons.join(' ')).not.toContain('owner or principal');
    expect(vp.reasons.join(' ')).toContain('senior leader');
  });

  it('still counts a plain president as an owner', () => {
    const president = scoreLead({ jobTitle: 'President' }, icp);

    expect(president.reasons.join(' ')).toContain('owner or principal');
  });

  it('matches whole words only, so "tech" does not fire on "Technology"', () => {
    const result = scoreLead({ jobTitle: 'Director of Technology' }, icp);

    expect(result.band).not.toBe('Disqualified');
    expect(result.reasons.join(' ')).toContain('senior leader');
  });

  it('penalises a competing agency rather than disqualifying it', () => {
    const result = scoreLead(
      { jobTitle: 'Founder', company: 'Peak SEO Marketing Agency' },
      icp,
    );

    expect(result.band).not.toBe('Disqualified');
    expect(result.reasons.join(' ')).toContain('competing agency');
    expect(result.score).toBeLessThan(scoreLead({ jobTitle: 'Founder' }, icp).score + 40);
  });

  it('gives every scored lead a reason for its score', () => {
    const result = scoreLead({ jobTitle: 'General Manager', company: 'Apex Plumbing Co' }, icp);

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    for (const reason of result.reasons) expect(reason).toMatch(/^[+-]\d+ /);
  });

  it('flags a row that carries no profile URL as unimportable', () => {
    expect(scoreLead({ jobTitle: 'Owner' }, icp).missingUrl).toBe(true);
    expect(
      scoreLead({ jobTitle: 'Owner', linkedinUrl: 'https://www.linkedin.com/in/x' }, icp).missingUrl,
    ).toBe(false);
  });

  it('scores zero with no reasons when nothing matches, rather than guessing', () => {
    const result = scoreLead({ fullName: 'A Person', jobTitle: 'Poet' }, icp);

    expect(result.score).toBe(0);
    expect(result.band).toBe('Out');
    expect(result.reasons).toEqual([]);
  });

  it('honours thresholds from a custom profile', () => {
    const lenient: IcpProfile = {
      name: 'test',
      description: 'test',
      hotAt: 10,
      warmAt: 5,
      coolAt: 1,
      rules: [{ label: 'any manager', match: ['manager'], points: 12, fields: ['jobTitle'] }],
    };

    expect(scoreLead({ jobTitle: 'Office Manager' }, lenient).band).toBe('Hot');
  });
});
