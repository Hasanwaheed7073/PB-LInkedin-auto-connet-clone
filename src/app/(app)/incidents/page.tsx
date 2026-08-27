import Link from 'next/link';

import { AlertTriangle, ShieldCheck } from 'lucide-react';

import { IncidentCard } from '@/components/incident-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, EmptyState } from '@/components/ui/misc';
import { prisma } from '@/lib/db';
import { getSystemState } from '@/lib/safety';
import { formatNumber } from '@/lib/utils';

export const metadata = { title: 'Incidents' };
export const dynamic = 'force-dynamic';

/**
 * Human intervention queue.
 *
 * The one screen an operator lands on when something has gone wrong. Everything
 * needed to decide is on the card: why, which lead, a screenshot if one was
 * captured, and the three actions.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const includeResolved = show === 'all';

  const [open, resolved, system, blockingCount] = await Promise.all([
    prisma.incident.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      include: {
        lead: { select: { id: true, fullName: true, linkedinUrl: true, status: true } },
        campaign: { select: { id: true, name: true } },
        worker: { select: { id: true, name: true } },
        queueJob: { select: { id: true, status: true, attempts: true, maxAttempts: true } },
      },
    }),
    includeResolved
      ? prisma.incident.findMany({
          where: { status: 'RESOLVED' },
          orderBy: { resolvedAt: 'desc' },
          take: 50,
          include: {
            lead: { select: { id: true, fullName: true, linkedinUrl: true, status: true } },
            campaign: { select: { id: true, name: true } },
            worker: { select: { id: true, name: true } },
            queueJob: { select: { id: true, status: true, attempts: true, maxAttempts: true } },
          },
        })
      : Promise.resolve([]),
    getSystemState(),
    prisma.incident.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, blocksWorker: true },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
          <p className="text-muted-foreground text-sm">
            {open.length === 0
              ? 'Nothing needs attention.'
              : `${formatNumber(open.length)} open, ${formatNumber(blockingCount)} holding automation.`}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={includeResolved ? '/incidents' : '/incidents?show=all'}>
            {includeResolved ? 'Hide resolved' : 'Show resolved'}
          </Link>
        </Button>
      </div>

      {blockingCount > 0 ? (
        <Callout
          tone="danger"
          title={`Human action required — the worker is held on ${formatNumber(blockingCount)} incident(s)`}
        >
          No job will run until these are resolved. Nothing here attempts to work around a LinkedIn
          security check: deal with it in the browser yourself, then resolve the incident.
        </Callout>
      ) : null}

      {system.killSwitchEngaged ? (
        <Callout tone="warning" title="Automation is stopped">
          {system.killSwitchReason ?? 'No reason recorded.'} Resolving incidents does not restart
          anything — clear the emergency stop explicitly, then activate the campaigns you want.
        </Callout>
      ) : null}

      {open.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<ShieldCheck className="text-success size-8" />}
              title="No open incidents"
              description="Nothing is waiting on a human."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {open.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}

      {includeResolved ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4" /> Resolved ({resolved.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {resolved.length === 0 ? (
              <EmptyState title="Nothing resolved yet" className="py-6" />
            ) : (
              <div className="flex flex-col gap-4">
                {resolved.map((incident) => (
                  <IncidentCard key={incident.id} incident={incident} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
