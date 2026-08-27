import Link from 'next/link';

import { ListOrdered } from 'lucide-react';

import { Pagination } from '@/components/pagination';
import { QueueJobActions } from '@/components/queue-job-actions';
import { QueueStatusBadge } from '@/components/status-badges';
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
import { getQueueCounts } from '@/lib/queue';
import { formatNumber, formatRelativeTime, formatTimestamp, humanizeEnum } from '@/lib/utils';
import { queueFilterSchema } from '@/lib/validation/schemas';

export const metadata = { title: 'Queue' };
export const dynamic = 'force-dynamic';

const STATUS_TABS = [
  { value: undefined, label: 'All' },
  { value: 'WAITING', label: 'Waiting' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'REQUIRES_REVIEW', label: 'Needs review' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const;

/**
 * The persistent outreach queue.
 *
 * Rows survive restarts of both the app and the worker; this page is a plain view
 * over the durable table.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = queueFilterSchema.safeParse(raw);
  const filter = parsed.success ? parsed.data : queueFilterSchema.parse({});

  const where = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    ...(filter.q
      ? { lead: { fullName: { contains: filter.q, mode: 'insensitive' as const } } }
      : {}),
  };

  const [counts, total, jobs, campaigns] = await Promise.all([
    getQueueCounts(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    prisma.queueJob.count({ where }),
    prisma.queueJob.findMany({
      where,
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { scheduledFor: 'asc' }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        lead: { select: { id: true, fullName: true, linkedinUrl: true } },
        campaign: { select: { id: true, name: true } },
        claimedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.campaign.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));
  const currentCampaign = campaigns.find((c) => c.id === filter.campaignId);

  function tabHref(status?: string) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (filter.campaignId) params.set('campaignId', filter.campaignId);
    const query = params.toString();
    return query ? `/queue?${query}` : '/queue';
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Outreach queue</h1>
        <p className="text-muted-foreground text-sm">
          {formatNumber(counts.waiting)} waiting · {formatNumber(counts.processing)} processing ·{' '}
          {formatNumber(counts.requiresReview)} needing review
          {currentCampaign ? ` · filtered to ${currentCampaign.name}` : ''}
        </p>
      </div>

      <div className="scroll-x flex gap-1.5">
        {STATUS_TABS.map((tab) => {
          const active = filter.status === tab.value;
          return (
            <Button
              key={tab.label}
              asChild
              variant={active ? 'default' : 'outline'}
              size="sm"
            >
              <Link href={tabHref(tab.value)}>{tab.label}</Link>
            </Button>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <EmptyState
              icon={<ListOrdered className="size-6" />}
              title={total === 0 ? 'The queue is empty' : 'No jobs match this filter'}
              description={
                total === 0
                  ? 'Activate a campaign, or generate its queue, to schedule work.'
                  : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">
                      {job.lead.fullName}
                      {job.claimedBy ? (
                        <div className="text-muted-foreground text-xs">
                          held by {job.claimedBy.name}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/campaigns/${job.campaign.id}`}
                        className="text-xs underline-offset-2 hover:underline"
                      >
                        {job.campaign.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{job.action}</Badge>
                    </TableCell>
                    <TableCell>
                      <QueueStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="tabular">{formatTimestamp(job.scheduledFor)}</div>
                      <div className="text-muted-foreground">
                        {formatRelativeTime(job.scheduledFor)}
                      </div>
                    </TableCell>
                    <TableCell className="tabular text-right text-sm">
                      {job.attempts}/{job.maxAttempts}
                    </TableCell>
                    <TableCell className="text-xs">
                      {job.result ? (
                        <span className="font-medium">{humanizeEnum(job.result)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {job.error ? (
                        <div className="text-destructive/90 line-clamp-2">{job.error}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <QueueJobActions
                        jobId={job.id}
                        status={job.status}
                        leadName={job.lead.fullName}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 ? (
        <Pagination page={filter.page} totalPages={totalPages} total={total} />
      ) : null}
    </div>
  );
}
