/**
 * Discovery provider contract.
 *
 * The rest of the application must never know which source a candidate came
 * from. Source-specific behaviour lives inside a provider or it does not exist:
 * nothing downstream of `normalize` may branch on `provider.id`.
 *
 * `compliance` is a required field rather than documentation. A source that
 * cannot state its lawful basis cannot be registered, which is what keeps
 * "just scrape it" from arriving later under deadline pressure.
 */

export interface ComplianceDeclaration {
  basis: 'public_api_tos' | 'public_record' | 'licensed_contract' | 'user_submitted';
  /** Link to the terms, licence or statute that permits this use. */
  reference: string;
  /** Obligations this source imposes on us downstream. */
  restrictions: string[];
  reviewedAt: string;
}

export interface Budget {
  maxRecords: number;
  maxRequests: number;
  /** Absolute deadline; the provider must stop cleanly, not truncate silently. */
  deadline: Date;
}

export interface DiscoveryCriteria {
  /** Ignore signals published before this. Freshness is the point. */
  since?: Date;
  /** Free-text terms a provider may use to narrow its search. */
  keywords?: string[];
  limit?: number;
}

/** Exactly what the source returned, kept verbatim so it can be reprocessed. */
export interface RawRecord {
  externalId: string;
  retrievedAt: Date;
  sourceUrl: string;
  payload: unknown;
}

/** A dated, attributable piece of evidence. Never a classification. */
export interface RawSignalEvidence {
  /** The words the person actually wrote. */
  text: string;
  sourceUrl: string;
  publishedAt: Date | null;
}

export interface NormalizedCandidate {
  identity: {
    fullName: string | null;
    email: string | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    website: string | null;
    /** `platform:handle`, e.g. `hackernews:pg`. Always present. */
    handles: string[];
  };
  attributes: {
    location: string | null;
    remote: string | null;
    willingToRelocate: string | null;
    employmentType: string | null;
    technologies: string | null;
    resumeUrl: string | null;
    summary: string | null;
  };
  signals: RawSignalEvidence[];
  provenance: {
    providerId: string;
    externalId: string;
    sourceUrl: string;
    retrievedAt: Date;
    publishedAt: Date | null;
  };
}

export interface NormalizationFailure {
  ok: false;
  reason: string;
  externalId: string;
}

export type NormalizeResult = NormalizedCandidate | NormalizationFailure;

export function isFailure(result: NormalizeResult): result is NormalizationFailure {
  return (result as NormalizationFailure).ok === false;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  checkedAt: Date;
}

export interface DiscoveryProvider {
  readonly id: string;
  readonly kind: 'public_web' | 'public_record' | 'licensed_vendor' | 'import' | 'owned';
  readonly compliance: ComplianceDeclaration;

  health(): Promise<ProviderHealth>;
  search(criteria: DiscoveryCriteria, budget: Budget): AsyncIterable<RawRecord>;
  /** Pure. Must not perform I/O, so it can be tested against fixtures. */
  normalize(raw: RawRecord): NormalizeResult;
}
