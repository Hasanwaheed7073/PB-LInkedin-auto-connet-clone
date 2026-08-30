import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CheckCircle2, Pencil, XCircle } from 'lucide-react';

import { ActivityTimeline } from '@/components/activity-timeline';
import { CampaignControls } from '@/components/campaign-controls';
import { SendBurst } from '@/components/send-burst';
import { CampaignStatusBadge, QueueStatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, DetailRow, EmptyState } from '@/components/ui/misc';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { evaluateCampaignEligibility, getQueueCounts } from '@/lib/queue';
import { ELIGIBILITY_MESSAGES } from '@/lib/schedule';
import { getLeadStatusCounts } from '@/lib/stats';
import {
  formatNumber,
  formatOperatingDays,
  formatRelativeTime,
  formatTimestamp,
  humanizeEnum,
  minutesToClock,
} from '@/lib/utils';
import { getActivationChecks } from '@/server/actions/campaigns';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { name: true },
  });
  return { title: campaign?.name ?? 'Campaign' };
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const env = serverEnv();

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { settings: true, messageTemplate: true },
  });
  if (!campaign) notFound();

  const [leadCounts, queueCounts, checks, eligibility, recentActivity, upcoming] =
    await Promise.all([
      getLeadStatusCounts({ campaignId: id }),
      getQueueCounts({ campaignId: id }),
      getActivationChecks(id),
      evaluateCampaignEligibility(),
      prisma.activityLog.findMany({
        where: { campaignId: id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: {
          lead: { select: { id: true, fullName: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.queueJob.findMany({
        where: { campaignId: id, status: { in: ['WAITING', 'PROCESSING'] } },
        orderBy: [{ priority: 'asc' }, { scheduledFor: 'asc' }],
        take: 10,
        include: { lead: { select: { fullName: true, linkedinUrl: true } } },
      }),
    ]);

  const eligible = eligibility.find((e) => e.campaignId === id);
  const blockingFailures = checks.filter((c) => c.blocking && !c.ok);
  const canEdit = !(campaign.active && campaign.status === 'RUNNING');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
            <CampaignStatusBadge status={campaign.status} active={campaign.active} />
          </div>
          {campaign.description ? (
            <p className="text-muted-foreground mt-1 text-sm">{campaign.description}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`/campaigns/${id}/edit`}>
                <Pencil className="size-3.5" />
                Edit
              </Link>
            </Button>
          ) : null}
          <SendBurst
            campaignId={id}
            waitingJobs={queueCounts.waiting}
            canSend={campaign.active && campaign.status === 'RUNNING'}
            disabledReason="Activate the campaign first"
          />
          <CampaignControls
            campaignId={id}
            campaignName={campaign.name}
            status={campaign.status}
            active={campaign.active}
            canActivate={blockingFailures.length === 0}
            pendingLeads={leadCounts.counts.PENDING}
            waitingJobs={queueCounts.waiting}
          />
        </div>
      </div>

      {campaign.pauseReason ? (
        <Callout tone="warning" title="Paused">
          {campaign.pauseReason}
          {campaign.pausedBy ? ` — by ${campaign.pausedBy}` : ''}
          {campaign.pausedAt ? ` (${formatRelativeTime(campaign.pausedAt)})` : ''}
        </Callout>
      ) : null}

      {campaign.lastError ? (
        <Callout tone="danger" title="Last error">
          {campaign.lastError}
        </Callout>
      ) : null}

      {/* --- Pre-flight checks ------------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Pre-flight checks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {checks.map((check) => (
              <li key={check.label} className="flex items-start gap-3 py-2.5 text-sm">
                {check.ok ? (
                  <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
                ) : (
                  <XCircle
                    className={`mt-0.5 size-4 shrink-0 ${
                      check.blocking ? 'text-destructive' : 'text-warning'
                    }`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{check.label}</span>
                    {!check.ok && !check.blocking ? (
                      <Badge variant="warning">Advisory</Badge>
                    ) : null}
                    {!check.ok && check.blocking ? (
                      <Badge variant="danger">Blocks activation</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            {campaign.settings ? (
              <dl className="divide-y">
                <DetailRow label="Timezone">{campaign.settings.timezone}</DetailRow>
                <DetailRow label="Operating window">
                  {minutesToClock(campaign.settings.windowStartMinute)}–
                  {minutesToClock(campaign.settings.windowEndMinute)}
                </DetailRow>
                <DetailRow label="Operating days">
                  {formatOperatingDays(campaign.settings.operatingDays)}
                </DetailRow>
                <DetailRow label="Daily limit">
                  <span className="tabular">{campaign.settings.dailyLimit}</span>
                </DetailRow>
                <DetailRow label="Global ceiling">
                  <span className="tabular">{env.GLOBAL_DAILY_ACTION_LIMIT}</span>
                </DetailRow>
                <DetailRow label="Spacing">
                  {campaign.settings.minActionDelaySeconds}–
                  {campaign.settings.maxActionDelaySeconds}s
                </DetailRow>
                <DetailRow label="Retries per lead">
                  <span className="tabular">{campaign.settings.maxAttemptsPerLead}</span>
                </DetailRow>
                <DetailRow label="Pause on incident">
                  {campaign.settings.pauseOnIncident ? 'Yes' : 'No'}
                </DetailRow>
                <DetailRow label="Skip unfillable notes">
                  {campaign.settings.skipLeadsMissingTemplateVars ? 'Yes' : 'No'}
                </DetailRow>
              </dl>
            ) : (
              <p className="text-destructive text-sm">
                This campaign has no settings row and cannot be scheduled.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Leads</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <DetailRow label="Total">
                <Link className="tabular underline" href={`/leads?campaignId=${id}`}>
                  {formatNumber(leadCounts.total)}
                </Link>
              </DetailRow>
              {(
                [
                  'PENDING',
                  'PROCESSING',
                  'SENT',
                  'ALREADY_CONNECTED',
                  'ALREADY_PENDING',
                  'SKIPPED',
                  'FAILED',
                  'REQUIRES_REVIEW',
                  'BLOCKED',
                ] as const
              ).map((status) => (
                <DetailRow key={status} label={humanizeEnum(status)}>
                  <span className="tabular">{formatNumber(leadCounts.counts[status])}</span>
                </DetailRow>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Queue &amp; eligibility</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <DetailRow label="Waiting">
                <span className="tabular">{formatNumber(queueCounts.waiting)}</span>
              </DetailRow>
              <DetailRow label="Processing">
                <span className="tabular">{formatNumber(queueCounts.processing)}</span>
              </DetailRow>
              <DetailRow label="Completed">
                <span className="tabular">{formatNumber(queueCounts.completed)}</span>
              </DetailRow>
              <DetailRow label="Failed">
                <span className="tabular">{formatNumber(queueCounts.failed)}</span>
              </DetailRow>
              <DetailRow label="Needs review">
                <span className="tabular">{formatNumber(queueCounts.requiresReview)}</span>
              </DetailRow>
              <DetailRow label="Cancelled">
                <span className="tabular">{formatNumber(queueCounts.cancelled)}</span>
              </DetailRow>
              <DetailRow label="Eligibility">
                {eligible ? (
                  <Badge variant={eligible.eligible ? 'success' : 'muted'}>
                    {eligible.eligible ? 'Eligible now' : ELIGIBILITY_MESSAGES[eligible.reason]}
                  </Badge>
                ) : (
                  <Badge variant="muted">Not activated</Badge>
                )}
              </DetailRow>
              {eligible?.nextEligibleAt && !eligible.eligible ? (
                <DetailRow label="Next eligible">
                  {formatRelativeTime(eligible.nextEligibleAt)}
                </DetailRow>
              ) : null}
              {eligible ? (
                <DetailRow label="Remaining today">
                  <span className="tabular">{formatNumber(eligible.remainingToday)}</span>
                </DetailRow>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </section>

      {campaign.messageTemplate ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              Connection note — {campaign.messageTemplate.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/50 scroll-x rounded-md p-3 text-sm whitespace-pre-wrap">
              {campaign.messageTemplate.body}
            </pre>
            <p className="text-muted-foreground mt-2 text-xs">
              Rendered per lead at send time, with a {env.MAX_CONNECTION_NOTE_CHARS}-character
              ceiling. A lead whose values cannot fill the template is{' '}
              {campaign.settings?.skipLeadsMissingTemplateVars ? 'skipped' : 'sent a bare invitation'}.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Next up</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {upcoming.length === 0 ? (
              <EmptyState
                title="Nothing queued"
                description="Generate the queue, or every lead is already resolved."
                className="py-6"
              />
            ) : (
              <ul className="divide-y text-sm">
                {upcoming.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
                    <span className="min-w-32 flex-1 font-medium">{job.lead.fullName}</span>
                    <QueueStatusBadge status={job.status} />
                    <span className="text-muted-foreground tabular text-xs">
                      {formatTimestamp(job.scheduledFor)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm">Campaign activity</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/activity?campaignId=${id}`}>View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <EmptyState title="No activity" className="py-6" />
            ) : (
              <ActivityTimeline entries={recentActivity} />
            )}
          </CardContent>
        </Card>
      </section>

      <p className="text-muted-foreground text-xs">
        Created {formatTimestamp(campaign.createdAt)}
        {campaign.activatedAt
          ? ` · activated ${formatTimestamp(campaign.activatedAt)} by ${campaign.activatedBy ?? 'unknown'}`
          : ''}
        {campaign.completedAt ? ` · completed ${formatTimestamp(campaign.completedAt)}` : ''}
      </p>
    </div>
  );
}
