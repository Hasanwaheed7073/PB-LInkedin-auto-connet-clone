import { CampaignForm } from '@/components/campaign-form';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';

export const metadata = { title: 'New campaign' };
export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  const env = serverEnv();

  const [templates, unassignedLeads] = await Promise.all([
    prisma.messageTemplate.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.lead.count({ where: { campaignId: null } }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>
        <p className="text-muted-foreground text-sm">
          Created as a draft. Assign leads, review the queue, then activate it deliberately.
          {unassignedLeads > 0 ? ` ${unassignedLeads} lead(s) are currently unassigned.` : ''}
        </p>
      </div>

      <CampaignForm
        templates={templates}
        globalDailyLimit={env.GLOBAL_DAILY_ACTION_LIMIT}
        initial={{
          name: '',
          description: '',
          messageTemplateId: null,
          // Conservative defaults: a short weekday window and a low daily limit.
          timezone: 'UTC',
          dailyLimit: 15,
          windowStartMinute: 9 * 60,
          windowEndMinute: 17 * 60,
          operatingDays: [1, 2, 3, 4, 5],
          minActionDelaySeconds: 60,
          maxActionDelaySeconds: 240,
          maxAttemptsPerLead: 3,
          pauseOnIncident: true,
          skipLeadsMissingTemplateVars: true,
        }}
      />
    </div>
  );
}
