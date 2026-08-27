'use client';

import * as React from 'react';

import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatNumber, humanizeEnum } from '@/lib/utils';
import type { LeadFilterInput } from '@/lib/validation/schemas';

const ALL = '__all__';

const STATUSES = [
  'PENDING',
  'PROCESSING',
  'SENT',
  'ALREADY_CONNECTED',
  'ALREADY_PENDING',
  'SKIPPED',
  'FAILED',
  'REQUIRES_REVIEW',
  'BLOCKED',
] as const;

/**
 * Lead search and filters.
 *
 * State lives in the URL, so a filtered view is shareable, survives a refresh,
 * and the server does the filtering.
 */
export function LeadFilters({
  campaigns,
  statusCounts,
  current,
}: {
  campaigns: { id: string; name: string }[];
  statusCounts: { status: string; _count: { _all: number } }[];
  current: LeadFilterInput;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = React.useState(current.q ?? '');

  const counts = new Map(statusCounts.map((s) => [s.status, s._count._all]));

  function update(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '' || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    // Any filter change returns to page 1; staying on page 7 of a new filter
    // would usually show an empty table.
    next.delete('page');
    router.push(`/leads?${next.toString()}`);
  }

  const hasFilters = !!(current.q || current.status || current.campaignId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-56 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: query.trim() || undefined });
          }}
        >
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, company, title or profile URL"
            className="pl-8"
            aria-label="Search leads"
          />
        </form>

        <Select
          value={current.status ?? ALL}
          onValueChange={(value) => update({ status: value })}
        >
          <SelectTrigger className="w-48" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {humanizeEnum(status)} ({formatNumber(counts.get(status) ?? 0)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={current.campaignId ?? ALL}
          onValueChange={(value) => update({ campaignId: value })}
        >
          <SelectTrigger className="w-52" aria-label="Filter by campaign">
            <SelectValue placeholder="All campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All campaigns</SelectItem>
            {campaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={`${current.sort}:${current.direction}`}
          onValueChange={(value) => {
            const [sort, direction] = value.split(':');
            update({ sort, direction });
          }}
        >
          <SelectTrigger className="w-44" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="createdAt:desc">Newest first</SelectItem>
            <SelectItem value="createdAt:asc">Oldest first</SelectItem>
            <SelectItem value="fullName:asc">Name A–Z</SelectItem>
            <SelectItem value="fullName:desc">Name Z–A</SelectItem>
            <SelectItem value="lastAttemptAt:desc">Recently attempted</SelectItem>
            <SelectItem value="status:asc">Status</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              setQuery('');
              router.push('/leads');
            }}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        ) : null}
      </div>

      {hasFilters ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {current.q ? <Badge variant="secondary">Search: {current.q}</Badge> : null}
          {current.status ? (
            <Badge variant="secondary">Status: {humanizeEnum(current.status)}</Badge>
          ) : null}
          {current.campaignId ? (
            <Badge variant="secondary">
              Campaign: {campaigns.find((c) => c.id === current.campaignId)?.name ?? 'unknown'}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
