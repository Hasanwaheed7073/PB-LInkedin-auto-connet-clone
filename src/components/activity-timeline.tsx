import Link from 'next/link';

import { ActivityResultBadge, PageStateBadge } from '@/components/status-badges';
import { formatDuration, formatTimestamp, humanizeEnum } from '@/lib/utils';

/**
 * Activity timeline.
 *
 * Renders rows from the append-only activity log. Matches the format in the
 * specification: timestamp, lead, action, result, and the reason when there is
 * one.
 */

export interface TimelineEntry {
  id: string;
  createdAt: Date;
  action: string;
  result: string;
  message: string | null;
  error: string | null;
  pageState: string | null;
  durationMs: number | null;
  lead: { id: string; fullName: string } | null;
  campaign: { id: string; name: string } | null;
}

export function ActivityTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="divide-y text-sm">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <time className="text-muted-foreground tabular shrink-0 text-xs">
              {formatTimestamp(entry.createdAt)}
            </time>

            {entry.lead ? (
              <Link
                href={`/leads?q=${encodeURIComponent(entry.lead.fullName)}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {entry.lead.fullName}
              </Link>
            ) : null}

            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {humanizeEnum(entry.action)}
            </span>

            <ActivityResultBadge result={entry.result} />

            {entry.pageState ? (
              <PageStateBadge state={entry.pageState as never} />
            ) : null}

            {entry.durationMs !== null ? (
              <span className="text-muted-foreground tabular text-xs">
                {formatDuration(entry.durationMs)}
              </span>
            ) : null}
          </div>

          {entry.error ? (
            <p className="text-destructive/90 text-xs">{entry.error}</p>
          ) : entry.message ? (
            <p className="text-muted-foreground text-xs">{entry.message}</p>
          ) : null}

          {entry.campaign ? (
            <p className="text-muted-foreground text-xs">
              Campaign:{' '}
              <Link
                href={`/campaigns/${entry.campaign.id}`}
                className="underline-offset-2 hover:underline"
              >
                {entry.campaign.name}
              </Link>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
