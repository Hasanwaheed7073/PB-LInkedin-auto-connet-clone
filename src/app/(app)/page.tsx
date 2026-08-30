import Link from 'next/link';

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Inbox,
  Users,
} from 'lucide-react';

import { ActivityTimeline } from '@/components/activity-timeline';
import { RecoverySweepButton } from '@/components/recovery-sweep-button';
import {
  ActivityResultBadge,
  CampaignStatusBadge,
  SessionStatusBadge,
  WorkerStatusBadge,
} from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, DetailRow, EmptyState, StatusDot } from '@/components/ui/misc';
import { redirect } from 'next/navigation';

import { activeBusinessProfile } from '@/lib/business-profile';
import { ELIGIBILITY_MESSAGES } from '@/lib/schedule';
import { getDashboardSnapshot, getRecentActivity, getRecentErrors } from '@/lib/stats';
import { formatNumber, formatRelativeTime, formatTimestamp } from '@/lib/utils';
import { detectUnhealthyWorkers } from '@/lib/workers';

export const metadata = { title: 'Dashboard' };

// Operational data - never serve it from a cache.
export const dynamic = 'force-dynamic';

/**
 * Dashboard.
 *
 * Every figure here is a live database read. There is no mock data and no
 * placeholder: where there is nothing to show, the panel says so.
 */
export default async function DashboardPage() {
  // Ask which business before showing numbers from it. Seeing one book of
  // business while believing you are looking at the other is how the wrong
  // list gets worked.
  if (!(await activeBusinessProfile())) redirect('/choose');

  // Flag workers whose heartbeat went stale, so the status shown is honest.
  // Deliberately does not start a replacement worker.
  await detectUnhealthyWorkers();

  const [snapshot, recentActivity, recentErrors] = await Promise.all([
    getDashboardSnapshot(),
    getRecentActivity(12),
    getRecentErrors(6),
  ]);

  const { leads, queue, today, incidents, workers, system, campaigns, eligibility, nextScheduled } =
    snapshot;
  const holder = workers.leaseHolder;

  const leadTiles = [
    { label: 'Total leads', value: leads.total, tone: 'default' as const, href: '/leads' },
    { label: 'Pending', value: leads.counts.PENDING, tone: 'muted' as const, href: '/leads?status=PENDING' },
    { label: 'Processing', value: leads.counts.PROCESSING, tone: 'info' as const, href: '/leads?status=PROCESSING' },
    { label: 'Invitations sent', value: leads.counts.SENT, tone: 'success' as const, href: '/leads?status=SENT' },
    {
      label: 'Already connected',
      value: leads.counts.ALREADY_CONNECTED,
      tone: 'secondary' as const,
      href: '/leads?status=ALREADY_CONNECTED',
    },
    {
      label: 'Already pending',
      value: leads.counts.ALREADY_PENDING,
      tone: 'secondary' as const,
      href: '/leads?status=ALREADY_PENDING',
    },
    { label: 'Skipped', value: leads.counts.SKIPPED, tone: 'muted' as const, href: '/leads?status=SKIPPED' },
    { label: 'Failed', value: leads.counts.FAILED, tone: 'danger' as const, href: '/leads?status=FAILED' },
    {
      label: 'Requires review',
      value: leads.counts.REQUIRES_REVIEW,
      tone: 'warning' as const,
      href: '/leads?status=REQUIRES_REVIEW',
    },
    { label: 'Blocked', value: leads.counts.BLOCKED, tone: 'danger' as const, href: '/leads?status=BLOCKED' },
  ];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">LinkedIn outreach</h1>
          <p className="text-muted-foreground text-sm">
            Live operational state as of {formatTimestamp(snapshot.generatedAt)}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RecoverySweepButton />
          <Button asChild variant="outline" size="sm">
            <Link href="/leads/import">Import leads</Link>
          </Button>
        </div>
      </div>

      {/* --- Things needing a human ------------------------------------- */}
      {incidents.blocking > 0 ? (
        <Callout
          tone="danger"
          title={`Human action required — ${incidents.blocking} incident(s) are holding automation`}
          action={
            <Button asChild variant="destructive" size="sm">
              <Link href="/incidents">Review incidents</Link>
            </Button>
          }
        >
          The worker will not process any job until these are resolved.
        </Callout>
      ) : null}

      {system.killSwitchEngaged ? (
        <Callout tone="danger" title="All automation is stopped">
          {system.killSwitchReason ?? 'No reason recorded.'}{' '}
          {system.killSwitchEngagedBy ? `Stopped by ${system.killSwitchEngagedBy}.` : ''} Clearing
          the stop does not restart campaigns — they must be activated again explicitly.
        </Callout>
      ) : null}

      {leads.total === 0 ? (
        <Callout
          tone="info"
          title="No leads yet"
          action={
            <Button asChild size="sm">
              <Link href="/leads/import">Import a CSV</Link>
            </Button>
          }
        >
          Import your lead list to get started. Nothing is sent until you create a campaign and
          activate it explicitly.
        </Callout>
      ) : null}

      {/* --- Lead counters ---------------------------------------------- */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {leadTiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="group">
            <Card className="h-full transition-colors group-hover:border-foreground/25">
              <CardContent className="flex flex-col gap-1 p-4">
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {tile.label}
                </span>
                <span className="tabular text-2xl font-semibold">{formatNumber(tile.value)}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      {/* --- Operational status ----------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4" /> Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <DetailRow label="Actions performed">
                <span className="tabular">
                  {formatNumber(today.actionsToday)} / {formatNumber(today.globalDailyLimit)}
                </span>
              </DetailRow>
              <DetailRow label="Invitations sent">
                <span className="tabular">{formatNumber(today.invitationsSentToday)}</span>
              </DetailRow>
              <DetailRow label="Already connected">
                <span className="tabular">{formatNumber(today.alreadyConnectedToday)}</span>
              </DetailRow>
              <DetailRow label="Already pending">
                <span className="tabular">{formatNumber(today.alreadyPendingToday)}</span>
              </DetailRow>
              <DetailRow label="Failed">
                <span className="tabular">{formatNumber(today.failedToday)}</span>
              </DetailRow>
              <DetailRow label="Needs review">
                <span className="tabular">{formatNumber(today.requiresReviewToday)}</span>
              </DetailRow>
              <DetailRow label="Global budget left">
                <span className="tabular">{formatNumber(today.globalRemaining)}</span>
              </DetailRow>
            </dl>
            <p className="text-muted-foreground mt-3 text-xs">
              Counted for the calendar day in {today.timezone}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="size-4" /> Worker &amp; session
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <DetailRow label="Worker">
                {holder ? (
                  <WorkerStatusBadge status={holder.status} healthy={holder.healthy} />
                ) : (
                  <Badge variant="muted">Not running</Badge>
                )}
              </DetailRow>
              <DetailRow label="Session">
                <SessionStatusBadge status={holder?.sessionStatus ?? 'UNKNOWN'} />
              </DetailRow>
              <DetailRow label="Browser">
                <Badge variant={holder?.browserStatus === 'OPEN' ? 'success' : 'muted'}>
                  {holder?.browserStatus ?? 'CLOSED'}
                </Badge>
              </DetailRow>
              <DetailRow label="Last heartbeat">
                {holder ? formatRelativeTime(holder.lastHeartbeatAt) : 'never'}
              </DetailRow>
              <DetailRow label="Jobs processed">
                <span className="tabular">{formatNumber(holder?.jobsProcessed ?? 0)}</span>
              </DetailRow>
              <DetailRow label="Automation">
                <Badge variant={system.killSwitchEngaged ? 'danger' : 'success'} className="gap-1.5">
                  <StatusDot tone={system.killSwitchEngaged ? 'danger' : 'success'} />
                  {system.killSwitchEngaged ? 'STOPPED' : 'Permitted'}
                </Badge>
              </DetailRow>
            </dl>
            {!holder ? (
              <p className="text-muted-foreground mt-3 text-xs">
                No worker has registered. Start one with{' '}
                <code className="font-mono">npm run worker</code>.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarClock className="size-4" /> Next scheduled task
            </CardTitle>
          </CardHeader>
          <CardContent>
            {nextScheduled ? (
              <dl className="divide-y">
                <DetailRow label="Lead">{nextScheduled.lead.fullName}</DetailRow>
                <DetailRow label="Campaign">
                  <Link className="underline" href={`/campaigns/${nextScheduled.campaign.id}`}>
                    {nextScheduled.campaign.name}
                  </Link>
                </DetailRow>
                <DetailRow label="Action">{nextScheduled.action}</DetailRow>
                <DetailRow label="Scheduled for">
                  {formatTimestamp(nextScheduled.scheduledFor)}
                </DetailRow>
                <DetailRow label="That is">
                  {formatRelativeTime(nextScheduled.scheduledFor)}
                </DetailRow>
              </dl>
            ) : (
              <EmptyState
                icon={<Clock className="size-6" />}
                title="Nothing scheduled"
                description="No waiting jobs on an activated campaign."
                className="py-6"
              />
            )}

            <div className="mt-4 space-y-2 border-t pt-3">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Queue
              </p>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="muted">Waiting {formatNumber(queue.waiting)}</Badge>
                <Badge variant="info">Processing {formatNumber(queue.processing)}</Badge>
                <Badge variant="success">Completed {formatNumber(queue.completed)}</Badge>
                <Badge variant="danger">Failed {formatNumber(queue.failed)}</Badge>
                <Badge variant="warning">Review {formatNumber(queue.requiresReview)}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* --- Campaign eligibility --------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Campaign status</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.total === 0 ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="No campaigns"
              description="Create a campaign to schedule outreach. It stays a draft until you activate it."
              action={
                <Button asChild size="sm">
                  <Link href="/campaigns/new">Create campaign</Link>
                </Button>
              }
            />
          ) : eligibility.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {campaigns.total} campaign(s) exist, none currently activated. Draft {campaigns.draft}
              , paused {campaigns.paused}, completed {campaigns.completed}.
            </p>
          ) : (
            <ul className="divide-y">
              {eligibility.map((row) => (
                <li key={row.campaignId} className="flex flex-wrap items-center gap-3 py-2.5">
                  <Link
                    href={`/campaigns/${row.campaignId}`}
                    className="min-w-40 flex-1 text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {row.campaignName}
                  </Link>
                  <Badge variant={row.eligible ? 'success' : 'muted'}>
                    {row.eligible ? 'Eligible now' : ELIGIBILITY_MESSAGES[row.reason]}
                  </Badge>
                  <span className="text-muted-foreground tabular text-xs">
                    {formatNumber(row.waitingJobs)} waiting · {formatNumber(row.remainingToday)}{' '}
                    left today
                  </span>
                  {row.nextEligibleAt && !row.eligible ? (
                    <span className="text-muted-foreground text-xs">
                      next {formatRelativeTime(row.nextEligibleAt)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Activity and errors ---------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm">Recent activity</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/activity">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <EmptyState title="No activity yet" description="Nothing has run." className="py-6" />
            ) : (
              <ActivityTimeline entries={recentActivity} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4" /> Recent errors
            </CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/incidents">Incidents</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentErrors.length === 0 ? (
              <EmptyState
                title="No errors"
                description="Nothing has failed or needed review."
                className="py-6"
              />
            ) : (
              <ul className="divide-y text-sm">
                {recentErrors.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-1 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground tabular text-xs">
                        {formatTimestamp(entry.createdAt)}
                      </span>
                      <ActivityResultBadge result={entry.result} />
                      {entry.lead ? <span className="font-medium">{entry.lead.fullName}</span> : null}
                    </div>
                    {entry.error ? (
                      <p className="text-muted-foreground line-clamp-2 text-xs">{entry.error}</p>
                    ) : entry.message ? (
                      <p className="text-muted-foreground line-clamp-2 text-xs">{entry.message}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
