'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireUser } from '@/lib/auth';
import { setActiveBusinessProfile } from '@/lib/business-profile';
import { prisma } from '@/lib/db';
import { logActivity } from '@/lib/activity';
import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const createProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  icpProfile: z.string().trim().max(120).optional(),
  badge: z.string().trim().max(4).optional(),
});

const selectProfileSchema = z.object({
  slug: z.string().trim().min(1).max(40),
});

export async function createBusinessProfile(
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const user = await requireUser();

  const parsed = validate(createProfileSchema, input);
  if (!parsed.ok) return parsed.result;

  const slug = slugify(parsed.data.name);
  if (slug.length === 0) {
    return actionError('That name has no letters or numbers in it to build an address from.');
  }

  const clash = await prisma.businessProfile.findFirst({
    where: { OR: [{ slug }, { name: parsed.data.name }] },
    select: { id: true },
  });
  if (clash) return actionError('A business with that name already exists.');

  const profile = await prisma.businessProfile.create({
    data: {
      name: parsed.data.name,
      slug,
      description: parsed.data.description || null,
      icpProfile: parsed.data.icpProfile || null,
      badge: parsed.data.badge || parsed.data.name.slice(0, 2).toUpperCase(),
    },
    select: { id: true, slug: true, name: true },
  });

  await logActivity({
    action: 'SETTINGS_UPDATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    message: `Business profile "${profile.name}" created.`,
    metadata: { businessProfileId: profile.id, slug: profile.slug },
  });

  revalidatePath('/choose');
  revalidatePath('/');
  return actionOk({ id: profile.id, slug: profile.slug }, `"${profile.name}" created.`);
}

/** Select the business to work on. A view filter, not a permission change. */
export async function selectBusinessProfile(input: unknown): Promise<ActionResult<{ slug: string }>> {
  await requireUser();

  const parsed = validate(selectProfileSchema, input);
  if (!parsed.ok) return parsed.result;

  const profile = await prisma.businessProfile.findUnique({
    where: { slug: parsed.data.slug },
    select: { slug: true, name: true, archivedAt: true },
  });
  if (!profile || profile.archivedAt) return actionError('That business no longer exists.');

  await setActiveBusinessProfile(profile.slug);

  revalidatePath('/', 'layout');
  return actionOk({ slug: profile.slug }, `Working on ${profile.name}.`);
}

/**
 * Move a campaign into a business, or out of one.
 *
 * Assignment is explicit rather than inferred: a campaign created before these
 * profiles existed belongs to whichever the operator says, and guessing from
 * its name would be a coin toss dressed as a feature.
 */
export async function assignCampaignToBusiness(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const parsed = validate(
    z.object({ campaignId: z.string().min(1), businessProfileId: z.string().min(1).nullable() }),
    input,
  );
  if (!parsed.ok) return parsed.result;

  const campaign = await prisma.campaign.update({
    where: { id: parsed.data.campaignId },
    data: { businessProfileId: parsed.data.businessProfileId },
    select: { id: true, name: true, businessProfile: { select: { name: true } } },
  });

  await logActivity({
    action: 'CAMPAIGN_UPDATED',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    campaignId: campaign.id,
    message: `Campaign "${campaign.name}" assigned to ${campaign.businessProfile?.name ?? 'no business'}.`,
  });

  revalidatePath('/campaigns');
  revalidatePath('/');
  return actionOk({ id: campaign.id }, 'Campaign moved.');
}
