import { cookies } from 'next/headers';

import { prisma } from './db';

/**
 * The business the operator is currently working on.
 *
 * The same dashboard serves unrelated books of business, and the parts they
 * share are exactly the dangerous ones: one queue, one worker, one set of daily
 * ceilings, one outreach history. Looking at one business's numbers while
 * working the other is how the wrong list gets sent, so the selection is
 * explicit and visible rather than inferred.
 *
 * It is a *view* filter, not a security boundary. Every profile belongs to the
 * same operator; switching is a convenience, and nothing here is a permission
 * check. Anything that must not be crossed - the duplicate guard, the daily
 * limits - is enforced in the database and applies across all of them.
 */

const ACTIVE_PROFILE_COOKIE = 'outreach_business';

export interface BusinessProfileSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  badge: string | null;
  icpProfile: string | null;
  /** False when this business is for finding and reviewing leads only. */
  outreachEnabled: boolean;
  campaigns: number;
  leads: number;
}

export async function listBusinessProfiles(): Promise<BusinessProfileSummary[]> {
  const rows = await prisma.businessProfile.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      campaigns: { select: { _count: { select: { leads: true } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    badge: row.badge,
    icpProfile: row.icpProfile,
    outreachEnabled: row.outreachEnabled,
    campaigns: row.campaigns.length,
    leads: row.campaigns.reduce((sum: number, c: { _count: { leads: number } }) => sum + c._count.leads, 0),
  }));
}

/** The selected profile, or null when none has been chosen yet. */
export async function activeBusinessProfile(): Promise<BusinessProfileSummary | null> {
  const store = await cookies();
  const slug = store.get(ACTIVE_PROFILE_COOKIE)?.value;
  if (!slug) return null;

  const profiles = await listBusinessProfiles();
  // A cookie naming a profile that has since been archived or renamed must not
  // silently show everything; it reads as "nothing selected" and the operator
  // is asked again.
  return profiles.find((p) => p.slug === slug) ?? null;
}

export async function setActiveBusinessProfile(slug: string): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_PROFILE_COOKIE, slug, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveBusinessProfile(): Promise<void> {
  const store = await cookies();
  store.delete(ACTIVE_PROFILE_COOKIE);
}

/**
 * A `where` fragment scoping campaigns to the active profile.
 *
 * Returns `{}` when nothing is selected, which shows everything. That is the
 * deliberate choice for a single-operator tool: an unscoped view is confusing,
 * but a silently empty one is worse - it looks like the leads are gone.
 */
export async function campaignScope(): Promise<{ businessProfileId?: string }> {
  const active = await activeBusinessProfile();
  return active ? { businessProfileId: active.id } : {};
}

/**
 * Scope for anything hanging off a campaign - leads, queue jobs, activity.
 *
 * Reached through the campaign relation because that is where the business
 * lives. A row with no campaign at all is excluded while a business is
 * selected: it belongs to no book of business, so showing it under one would
 * be a guess.
 */
export async function byCampaignScope(): Promise<
  { campaign?: { businessProfileId: string } } | Record<string, never>
> {
  const active = await activeBusinessProfile();
  return active ? { campaign: { businessProfileId: active.id } } : {};
}

/**
 * Scope for incidents.
 *
 * Deliberately different: an incident with no campaign is a worker- or
 * account-level problem - an expired session, a CAPTCHA, a restriction - and it
 * halts every business at once. Hiding those behind a business filter would let
 * the thing that has stopped all work be invisible from the business you happen
 * to be looking at.
 */
export async function incidentScope(): Promise<Record<string, unknown>> {
  const active = await activeBusinessProfile();
  if (!active) return {};
  return {
    OR: [{ campaignId: null }, { campaign: { businessProfileId: active.id } }],
  };
}
