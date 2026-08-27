import Link from 'next/link';

import { Upload, Users } from 'lucide-react';

import { LeadStatusBadge } from '@/components/status-badges';
import { LeadFilters } from '@/components/lead-filters';
import { Pagination } from '@/components/pagination';
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
import { formatNumber, formatRelativeTime, truncate } from '@/lib/utils';
import { leadFilterSchema } from '@/lib/validation/schemas';

export const metadata = { title: 'Leads' };
export const dynamic = 'force-dynamic';

/**
 * Lead list: search, status filter, campaign filter, sorting, pagination.
 *
 * All filtering happens in the database - the page never loads 600 rows to
 * filter them in memory.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = leadFilterSchema.safeParse(raw);
  const filter = parsed.success ? parsed.data : leadFilterSchema.parse({});

  const where = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    ...(filter.q
      ? {
          OR: [
            { fullName: { contains: filter.q, mode: 'insensitive' as const } },
            { company: { contains: filter.q, mode: 'insensitive' as const } },
            { jobTitle: { contains: filter.q, mode: 'insensitive' as const } },
            { linkedinUrl: { contains: filter.q.toLowerCase() } },
          ],
        }
      : {}),
  };

  const [total, leads, campaigns, statusGroups] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: { [filter.sort]: filter.direction },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: { campaign: { select: { id: true, name: true } } },
    }),
    prisma.campaign.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / filter.pageSize));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-muted-foreground text-sm">
            {formatNumber(total)} matching{' '}
            {filter.status || filter.q || filter.campaignId ? 'this filter' : 'in total'}.
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/leads/import">
            <Upload className="size-4" />
            Import CSV
          </Link>
        </Button>
      </div>

      <LeadFilters campaigns={campaigns} statusCounts={statusGroups} current={filter} />

      <Card>
        <CardContent className="p-0">
          {leads.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title={total === 0 ? 'No leads yet' : 'No leads match this filter'}
              description={
                total === 0
                  ? 'Import a CSV to build your lead list. Nothing is contacted until you activate a campaign.'
                  : 'Try clearing the search or status filter.'
              }
              action={
                total === 0 ? (
                  <Button asChild size="sm">
                    <Link href="/leads/import">Import CSV</Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Last attempt</TableHead>
                  <TableHead>Profile</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">
                      {lead.fullName}
                      {lead.lastResult ? (
                        <div className="text-muted-foreground text-xs">{lead.lastResult}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{lead.company ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {lead.jobTitle ? truncate(lead.jobTitle, 40) : '—'}
                    </TableCell>
                    <TableCell>
                      {lead.campaign ? (
                        <Link
                          href={`/campaigns/${lead.campaign.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {truncate(lead.campaign.name, 24)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <LeadStatusBadge status={lead.status} />
                    </TableCell>
                    <TableCell className="tabular text-right">{lead.attempts}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {lead.lastAttemptAt ? formatRelativeTime(lead.lastAttemptAt) : 'never'}
                    </TableCell>
                    <TableCell>
                      <a
                        href={lead.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs underline-offset-2 hover:underline"
                      >
                        /in/{truncate(lead.publicIdentifier, 20)}
                      </a>
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
