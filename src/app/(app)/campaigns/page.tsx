import Link from 'next/link';

import { Plus, Target } from 'lucide-react';

import { CampaignStatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/misc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { prisma } from '@/lib/db';
import { campaignScope } from '@/lib/business-profile';
import { evaluateCampaignEligibility } from '@/lib/queue';
import { ELIGIBILITY_MESSAGES } from '@/lib/schedule';
import { formatNumber, formatOperatingDays, formatRelativeTime, minutesToClock } from '@/lib/utils';

export const metadata = { title: 'Campaigns' };
export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const [campaigns, eligibility] = await Promise.all([
    prisma.campaign.findMany({
      // Scoped to the business being worked on, so two unrelated books of
      // business are never read as one list.
      where: await campaignScope(),
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      include: {
        settings: true,
        messageTemplate: { select: { id: true, name: true } },
        _count: { select: { leads: true } },
      },
    }),
    evaluateCampaignEligibility(),
  ]);

  const eligibilityById = new Map(eligibility.map((e) => [e.campaignId, e]));

  // Per-campaign lead progress, computed in the database.
  const leadStats = await prisma.lead.groupBy({
    by: ['campaignId', 'status'],
    _count: { _all: true },
  });

  const progress = new Map<string, { sent: number; pending: number; review: number }>();
  for (const row of leadStats) {
    if (!row.campaignId) continue;
    const entry = progress.get(row.campaignId) ?? { sent: 0, pending: 0, review: 0 };
    if (row.status === 'SENT') entry.sent += row._count._all;
    if (row.status === 'PENDING') entry.pending += row._count._all;
    if (row.status === 'REQUIRES_REVIEW') entry.review += row._count._all;
    progress.set(row.campaignId, entry);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground text-sm">
            A campaign only runs after you activate it explicitly.
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/campaigns/new">
            <Plus className="size-4" />
            New campaign
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {campaigns.length === 0 ? (
            <EmptyState
              icon={<Target className="size-6" />}
              title="No campaigns yet"
              description="A campaign holds the schedule, the daily limit and the message template for a group of leads."
              action={
                <Button asChild size="sm">
                  <Link href="/campaigns/new">Create campaign</Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Daily limit</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Eligibility</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((campaign) => {
                  const stats = progress.get(campaign.id) ?? { sent: 0, pending: 0, review: 0 };
                  const eligible = eligibilityById.get(campaign.id);

                  return (
                    <TableRow key={campaign.id}>
                      <TableCell>
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {campaign.name}
                        </Link>
                        {campaign.pauseReason ? (
                          <div className="text-muted-foreground text-xs">
                            {campaign.pauseReason}
                          </div>
                        ) : campaign.description ? (
                          <div className="text-muted-foreground line-clamp-1 text-xs">
                            {campaign.description}
                          </div>
                        ) : null}
                      </TableCell>

                      <TableCell>
                        <CampaignStatusBadge status={campaign.status} active={campaign.active} />
                      </TableCell>

                      <TableCell className="text-xs">
                        <span className="tabular font-medium">
                          {formatNumber(campaign._count.leads)}
                        </span>
                        <div className="text-muted-foreground">
                          {formatNumber(stats.sent)} sent · {formatNumber(stats.pending)} pending
                          {stats.review > 0 ? ` · ${formatNumber(stats.review)} review` : ''}
                        </div>
                      </TableCell>

                      <TableCell className="text-xs">
                        {campaign.settings ? (
                          <>
                            <div>
                              {minutesToClock(campaign.settings.windowStartMinute)}–
                              {minutesToClock(campaign.settings.windowEndMinute)}
                            </div>
                            <div className="text-muted-foreground">
                              {formatOperatingDays(campaign.settings.operatingDays)} ·{' '}
                              {campaign.settings.timezone}
                            </div>
                          </>
                        ) : (
                          <span className="text-destructive">No settings</span>
                        )}
                      </TableCell>

                      <TableCell className="tabular text-sm">
                        {campaign.settings?.dailyLimit ?? '—'}
                      </TableCell>

                      <TableCell className="text-xs">
                        {campaign.messageTemplate ? (
                          <Link
                            href="/templates"
                            className="underline-offset-2 hover:underline"
                          >
                            {campaign.messageTemplate.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">No note</span>
                        )}
                      </TableCell>

                      <TableCell className="text-xs">
                        {eligible ? (
                          <>
                            <Badge variant={eligible.eligible ? 'success' : 'muted'}>
                              {eligible.eligible
                                ? 'Eligible now'
                                : ELIGIBILITY_MESSAGES[eligible.reason]}
                            </Badge>
                            {eligible.nextEligibleAt && !eligible.eligible ? (
                              <div className="text-muted-foreground mt-1">
                                next {formatRelativeTime(eligible.nextEligibleAt)}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Not activated</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
