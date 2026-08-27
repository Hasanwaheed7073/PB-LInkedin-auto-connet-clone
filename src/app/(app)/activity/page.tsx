import Link from 'next/link';

import { Activity } from 'lucide-react';

import { ActivityTimeline } from '@/components/activity-timeline';
import { Pagination } from '@/components/pagination';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/misc';
import { prisma } from '@/lib/db';
import { formatNumber } from '@/lib/utils';
import { activityFilterSchema } from '@/lib/validation/schemas';

export const metadata = { title: 'Activity log' };
export const dynamic = 'force-dynamic';

const RESULT_TABS = [
  { value: undefined, label: 'All' },
  { value: 'SUCCESS', label: 'Sent' },
  { value: 'ALREADY_CONNECTED', label: 'Already connected' },
  { value: 'ALREADY_PENDING', label: 'Already pending' },
  { value: 'SKIPPED', label: 'Skipped' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'REQUIRES_REVIEW', label: 'Needs review' },
  { value: 'INFO', label: 'System' },
] as const;

/**
 * The immutable activity log.
 *
 * Append-only, enforced by a database trigger. Nothing on this page can edit or
 * delete a row - there is deliberately no such action anywhere in the product.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = activityFilterSchema.safeParse(raw);
  const filter = parsed.success ? parsed.data : activityFilterSchema.parse({});

  const where = {
    ...(filter.result ? { result: filter.result } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    ...(filter.leadId ? { leadId: filter.leadId } : {}),
    ...(filter.q
      ? {
          OR: [
            { message: { contains: filter.q, mode: 'insensitive' as const } },
            { error: { contains: filter.q, mode: 'insensitive' as const } },
            { lead: { fullName: { contains: filter.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, entries, campaign] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        lead: { select: { id: true, fullName: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    filter.campaignId
      ? prisma.campaign.findUnique({
          where: { id: filter.campaignId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));

  function tabHref(result?: string) {
    const params = new URLSearchParams();
    if (result) params.set('result', result);
    if (filter.campaignId) params.set('campaignId', filter.campaignId);
    const query = params.toString();
    return query ? `/activity?${query}` : '/activity';
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
        <p className="text-muted-foreground text-sm">
          {formatNumber(total)} record(s){campaign ? ` for ${campaign.name}` : ''}. Append-only —
          entries can never be edited or deleted.
        </p>
      </div>

      <div className="scroll-x flex gap-1.5">
        {RESULT_TABS.map((tab) => (
          <Button
            key={tab.label}
            asChild
            variant={filter.result === tab.value ? 'default' : 'outline'}
            size="sm"
          >
            <Link href={tabHref(tab.value)}>{tab.label}</Link>
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className={entries.length === 0 ? 'p-0' : 'px-5'}>
          {entries.length === 0 ? (
            <EmptyState
              icon={<Activity className="size-6" />}
              title={total === 0 ? 'Nothing has happened yet' : 'No records match this filter'}
              description={
                total === 0
                  ? 'Every action, state change and safety event is recorded here once things start running.'
                  : undefined
              }
            />
          ) : (
            <ActivityTimeline entries={entries} />
          )}
        </CardContent>
      </Card>

      {totalPages > 1 ? (
        <Pagination page={filter.page} totalPages={totalPages} total={total} />
      ) : null}
    </div>
  );
}
