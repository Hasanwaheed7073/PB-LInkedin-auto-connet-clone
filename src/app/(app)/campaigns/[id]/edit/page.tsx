import { notFound } from 'next/navigation';

import { CampaignForm } from '@/components/campaign-form';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';

export const metadata = { title: 'Edit campaign' };
export const dynamic = 'force-dynamic';

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const env = serverEnv();

  const [campaign, templates] = await Promise.all([
    prisma.campaign.findUnique({ where: { id }, include: { settings: true } }),
    prisma.messageTemplate.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  if (!campaign || !campaign.settings) notFound();

  // A running campaign must be paused first: changing the schedule or note
  // mid-run would mean the audit trail no longer matches what was activated.
  const running = campaign.active && campaign.status === 'RUNNING';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit “{campaign.name}”</h1>
        <p className="text-muted-foreground text-sm">
          Saving does not activate the campaign. Status stays {campaign.status}.
        </p>
      </div>

      <CampaignForm
        templates={templates}
        globalDailyLimit={env.GLOBAL_DAILY_ACTION_LIMIT}
        disabled={running}
        disabledReason="Pause the campaign before editing it. Changing the schedule or note while it is running would apply mid-run."
        initial={{
          id: campaign.id,
          name: campaign.name,
          description: campaign.description ?? '',
          messageTemplateId: campaign.messageTemplateId,
          timezone: campaign.settings.timezone,
          dailyLimit: campaign.settings.dailyLimit,
          windowStartMinute: campaign.settings.windowStartMinute,
          windowEndMinute: campaign.settings.windowEndMinute,
          operatingDays: campaign.settings.operatingDays,
          minActionDelaySeconds: campaign.settings.minActionDelaySeconds,
          maxActionDelaySeconds: campaign.settings.maxActionDelaySeconds,
          maxAttemptsPerLead: campaign.settings.maxAttemptsPerLead,
          pauseOnIncident: campaign.settings.pauseOnIncident,
          skipLeadsMissingTemplateVars: campaign.settings.skipLeadsMissingTemplateVars,
        }}
      />
    </div>
  );
}
