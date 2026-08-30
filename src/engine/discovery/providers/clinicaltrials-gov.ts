/**
 * ClinicalTrials.gov discovery provider.
 *
 * The US government's own registry of clinical studies, published under a free,
 * documented, unauthenticated API. Every recruiting study lists the people a
 * patient should contact about it, and at site level those are overwhelmingly
 * the coordinators: "Charity Ruhl, LPN", "Toan Bui, BS", "Shengai Li, MS".
 *
 * That makes it the clinical-research equivalent of the Hacker News thread -
 * a public, official, credential-free source full of exactly the audience,
 * with names, roles, employers, locations and often an email address.
 *
 * Two limits stated plainly, because both shape what these leads are worth:
 *
 * 1. There are no LinkedIn URLs here. These are name, employer, location and
 *    usually an email - so they are email leads, and cannot be stored as leads
 *    in the outreach app, which identifies a person by their profile URL.
 * 2. This data is published so that *patients* can ask about trials. Using it
 *    to reach the same people about their careers is a different purpose than
 *    the one it was posted for. It is public record and lawful to read, but a
 *    coordinator who gets a career pitch on a study inbox may reasonably find
 *    it presumptuous, and that is a judgement for the operator rather than a
 *    detail to bury.
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

const API = 'https://clinicaltrials.gov/api/v2/studies';

interface CtContact {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
}

interface CtLocation {
  facility?: string;
  city?: string;
  state?: string;
  country?: string;
  contacts?: CtContact[];
}

interface CtStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: { overallStatus?: string; lastUpdatePostDateStruct?: { date?: string } };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    contactsLocationsModule?: { centralContacts?: CtContact[]; locations?: CtLocation[] };
  };
}

/**
 * Credentials that appear after a contact's name.
 *
 * The distinction that matters: a coordinator's credentials (RN, LPN, CCRC, BS,
 * MS, MPH) mark the audience, while MD and DO mark an investigator - the other
 * side of the site, and not who a training-and-placement offer is for.
 */
const COORDINATOR_CREDENTIALS = [
  'rn', 'bsn', 'msn', 'lpn', 'lvn', 'np', 'pa-c', 'pa',
  'ccrc', 'ccrp', 'ccra', 'crc', 'ccrn', 'acrp', 'socra',
  'bs', 'ba', 'bsc', 'ms', 'msc', 'ma', 'mph', 'mha', 'mba',
  'rd', 'rt', 'cls', 'mt', 'emt', 'cma',
];

const INVESTIGATOR_CREDENTIALS = ['md', 'do', 'dds', 'dmd', 'dvm', 'mbbs'];

/** Roles that are investigators rather than study staff. */
const INVESTIGATOR_ROLES = ['PRINCIPAL_INVESTIGATOR', 'SUB_INVESTIGATOR', 'STUDY_DIRECTOR', 'STUDY_CHAIR'];

export interface ParsedName {
  /** The person's name with credentials stripped. */
  name: string;
  credentials: string[];
  isInvestigator: boolean;
  isCoordinator: boolean;
}

/**
 * Split "Charity Ruhl, LPN" into a name and its credentials.
 *
 * A person can hold both kinds - "Pamela B Allen, MD, MSc" - and an MD is
 * decisive: someone with a medical degree listed on a trial is the
 * investigator, whatever else follows.
 */
export function parseContactName(raw: string): ParsedName {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? '';
  const credentials = parts
    .slice(1)
    .flatMap((p) => p.split(/[\s/]+/))
    .map((c) => c.replace(/\./g, '').toLowerCase())
    .filter(Boolean);

  return {
    name,
    credentials,
    isInvestigator: credentials.some((c) => INVESTIGATOR_CREDENTIALS.includes(c)),
    isCoordinator: credentials.some((c) => COORDINATOR_CREDENTIALS.includes(c)),
  };
}

/**
 * Words that describe a job rather than name a person.
 *
 * Sites frequently put the role in the contact-name field - "Study
 * Coordinator", "Site Lead", "Research Nurse" - and those rows read as people
 * until you try to greet one. A name made entirely of these is a desk, not
 * somebody you can write to by name.
 */
const ROLE_WORDS = new Set([
  'study', 'clinical', 'research', 'trial', 'trials', 'site', 'lead', 'team',
  'coordinator', 'coordinators', 'manager', 'nurse', 'contact', 'office',
  'recruitment', 'recruiter', 'staff', 'central', 'main', 'general', 'info',
  'enrollment', 'screening', 'navigator', 'specialist', 'department', 'unit',
  'program', 'project', 'principal', 'investigator', 'director', 'coordinating',
  // 'Site Public Contact' alone accounted for 142 rows in the first real run.
  'public', 'phone', 'email', 'line', 'desk', 'hotline', 'referral', 'referrals',
  'intake', 'admin', 'administrator', 'help', 'helpline', 'inquiries', 'inquiry',
]);

/** A name is only a name if it looks like one; sponsors list themselves as contacts. */
export function looksLikePerson(name: string): boolean {
  if (name.length < 4 || name.length > 60) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  // "Boehringer Ingelheim", "Clinical Trials Information" and similar.
  if (/\b(inc|ltd|llc|gmbh|corp|university|hospital|center|centre|institute|trials?|information|department|group|study team|research)\b/i.test(name)) {
    return false;
  }

  // Every word is a job word: a role in the name field, not a person.
  const meaningful = words.filter((w) => /[a-z]/i.test(w));
  if (meaningful.every((w) => ROLE_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) {
    return false;
  }

  return /^[A-Z]/.test(name);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'lead-intelligence/0.1' },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class ClinicalTrialsGovProvider implements DiscoveryProvider {
  readonly id = 'clinicaltrials_gov';
  readonly kind = 'public_record' as const;
  readonly compliance = {
    basis: 'public_record' as const,
    reference:
      'https://clinicaltrials.gov/data-api/api — US National Library of Medicine registry, ' +
      'published under 42 CFR Part 11 and served by a free unauthenticated API.',
    restrictions: [
      'Published so patients can enquire about trials. Career outreach is a different purpose than the one this contact data was posted for - decide deliberately whether that is appropriate.',
      'Investigators (MD, DO, principal and sub-investigators) are excluded: they are not the audience.',
      'Study inboxes are shared. A message may be read by several people at the site.',
    ],
    reviewedAt: '2026-08-31',
  };

  async health(): Promise<ProviderHealth> {
    try {
      const data = await fetchJson<{ studies?: CtStudy[] }>(
        `${API}?filter.overallStatus=RECRUITING&pageSize=1`,
      );
      return {
        ok: (data.studies?.length ?? 0) > 0,
        detail: `registry reachable; sample study ${data.studies?.[0]?.protocolSection?.identificationModule?.nctId ?? '-'}`,
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

  async *search(criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord> {
    let pageToken: string | undefined;
    let requests = 0;
    let emitted = 0;
    const seen = new Set<string>();

    // Condition terms narrow the therapeutic area; without them the whole
    // recruiting registry is walked, newest first.
    const term = criteria.keywords?.length
      ? `&query.cond=${encodeURIComponent(criteria.keywords.join(' OR '))}`
      : '';

    while (emitted < budget.maxRecords && requests < budget.maxRequests) {
      if (Date.now() > budget.deadline.getTime()) return;

      const url =
        `${API}?filter.overallStatus=RECRUITING&query.locn=United+States${term}` +
        `&pageSize=200&sort=LastUpdatePostDate:desc` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

      const page = await fetchJson<{ studies?: CtStudy[]; nextPageToken?: string }>(url);
      requests += 1;

      for (const study of page.studies ?? []) {
        const protocol = study.protocolSection;
        const nctId = protocol?.identificationModule?.nctId ?? '';
        const cl = protocol?.contactsLocationsModule;
        if (!nctId || !cl) continue;

        // US locations only, and each location's own contacts are the ones
        // most likely to be site staff rather than a sponsor call centre.
        const usLocations = (cl.locations ?? []).filter((l) => l.country === 'United States');

        const pairs: { contact: CtContact; location: CtLocation | null }[] = [
          ...(cl.centralContacts ?? []).map((contact) => ({
            contact,
            location: usLocations[0] ?? null,
          })),
          ...usLocations.flatMap((location) =>
            (location.contacts ?? []).map((contact) => ({ contact, location })),
          ),
        ];

        for (const pair of pairs) {
          if (emitted >= budget.maxRecords) return;
          const name = (pair.contact.name ?? '').trim();
          if (!name) continue;

          // One row per person per study; the same coordinator often appears as
          // both a central and a location contact.
          const key = `${nctId}:${(pair.contact.email ?? name).toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          emitted += 1;
          yield {
            externalId: `ctgov:${key}`,
            retrievedAt: new Date(),
            sourceUrl: `https://clinicaltrials.gov/study/${nctId}`,
            payload: { study, contact: pair.contact, location: pair.location, nctId },
          };
        }
      }

      pageToken = page.nextPageToken;
      if (!pageToken) return;
    }
  }

  normalize(raw: RawRecord): NormalizeResult {
    const { study, contact, location, nctId } = raw.payload as {
      study: CtStudy;
      contact: CtContact;
      location: CtLocation | null;
      nctId: string;
    };

    const rawName = (contact.name ?? '').trim();
    const parsed = parseContactName(rawName);

    if (!looksLikePerson(parsed.name)) {
      return {
        ok: false,
        reason: 'Contact is an organisation or a shared inbox, not a person',
        externalId: raw.externalId,
      };
    }

    const protocolEarly = study.protocolSection;
    const sponsorName = protocolEarly?.sponsorCollaboratorsModule?.leadSponsor?.name ?? '';

    // A company listed as its own contact - "Boehringer Ingelheim" - is two
    // capitalised words with no corporate suffix, so it reads as a person's
    // name and no amount of word-shape checking will separate them. Comparing
    // against the sponsor and the site does, exactly.
    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const contactKey = normalise(parsed.name);
    for (const org of [sponsorName, location?.facility ?? '']) {
      const orgKey = normalise(org);
      if (orgKey.length >= 6 && contactKey.length >= 6) {
        if (orgKey.includes(contactKey) || contactKey.includes(orgKey)) {
          return {
            ok: false,
            reason: 'Contact is the sponsor or the site itself, not a person',
            externalId: raw.externalId,
          };
        }
      }
    }

    if (contact.role && INVESTIGATOR_ROLES.includes(contact.role)) {
      return { ok: false, reason: `Listed as ${contact.role}`, externalId: raw.externalId };
    }

    if (parsed.isInvestigator) {
      return {
        ok: false,
        reason: `Holds an investigator credential (${parsed.credentials.join(', ')})`,
        externalId: raw.externalId,
      };
    }

    const protocol = study.protocolSection;
    const facility = location?.facility ?? protocol?.sponsorCollaboratorsModule?.leadSponsor?.name ?? null;
    const place = [location?.city, location?.state].filter(Boolean).join(', ') || null;
    const updated = protocol?.statusModule?.lastUpdatePostDateStruct?.date ?? null;

    // The credentials are the strongest role evidence this source carries, so
    // they are surfaced as the title rather than left buried in the name.
    const credentialLabel = parsed.credentials.length
      ? parsed.credentials.map((c) => c.toUpperCase()).join(', ')
      : null;

    const candidate: NormalizedCandidate = {
      identity: {
        fullName: parsed.name,
        email: contact.email?.toLowerCase().trim() ?? null,
        linkedinUrl: null,
        githubUrl: null,
        website: null,
        handles: [],
      },
      attributes: {
        location: place,
        remote: null,
        willingToRelocate: null,
        employmentType: null,
        technologies: credentialLabel
          ? `Clinical research study contact (${credentialLabel})`
          : 'Clinical research study contact',
        resumeUrl: null,
        summary: [
          `Listed as a study contact on ${nctId}.`,
          protocol?.identificationModule?.briefTitle,
          facility ? `Site: ${facility}.` : null,
          contact.phone ? `Phone on the registry entry.` : null,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1_000),
      },
      signals: [
        {
          text:
            `Named study contact on a recruiting clinical trial (${nctId})` +
            (credentialLabel ? `, credentials ${credentialLabel}` : '') +
            (facility ? `, at ${facility}` : ''),
          sourceUrl: raw.sourceUrl,
          // The registry's last-update date, which is when the site last
          // touched the record - not when this person took the role.
          publishedAt: updated ? new Date(updated) : null,
        },
      ],
      provenance: {
        providerId: this.id,
        externalId: raw.externalId,
        sourceUrl: raw.sourceUrl,
        retrievedAt: raw.retrievedAt,
        publishedAt: updated ? new Date(updated) : null,
      },
    };

    return candidate;
  }
}
