import { Cpu } from 'lucide-react';

import { RecoverySweepButton } from '@/components/recovery-sweep-button';
import { SessionStatusBadge, WorkerStatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, DetailRow, EmptyState } from '@/components/ui/misc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getSystemState } from '@/lib/safety';
import { formatDuration, formatNumber, formatRelativeTime, formatTimestamp } from '@/lib/utils';
import { detectUnhealthyWorkers, summarizeWorkers } from '@/lib/workers';

export const metadata = { title: 'Worker' };
export const dynamic = 'force-dynamic';

/**
 * Worker health and the exclusive run lease.
 *
 * Only one worker may hold the lease. This page is where an operator confirms
 * that, and sees why a second worker was refused.
 */
export default async function WorkersPage() {
  await detectUnhealthyWorkers();

  const env = serverEnv();

  const [summary, workers, system, processingJobs] = await Promise.all([
    summarizeWorkers(),
    prisma.worker.findMany({ orderBy: { startedAt: 'desc' }, take: 25 }),
    getSystemState(),
    prisma.queueJob.findMany({
      where: { status: 'PROCESSING' },
      include: {
        lead: { select: { fullName: true } },
        campaign: { select: { name: true } },
        claimedBy: { select: { name: true } },
      },
    }),
  ]);

  const holder = summary.leaseHolder;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Worker</h1>
          <p className="text-muted-foreground text-sm">
            One worker at a time holds the exclusive run lease. A second worker is refused rather
            than allowed to double-send.
          </p>
        </div>
        <RecoverySweepButton />
      </div>

      {!holder ? (
        <Callout tone="info" title="No worker is running">
          <p>
            Start one with <code className="font-mono text-xs">npm run worker</code>. It will
            register, take the run lease, open the persistent browser profile and verify the
            LinkedIn session before claiming any job.
          </p>
          <p className="mt-2">
            If the profile is not signed in, run{' '}
            <code className="font-mono text-xs">npm run worker -- --login</code> first and sign in
            by hand.
          </p>
        </Callout>
      ) : null}

      {holder && !holder.healthy ? (
        <Callout tone="danger" title="The worker has stopped sending heartbeats">
          Last heartbeat {formatRelativeTime(holder.lastHeartbeatAt)} (threshold{' '}
          {formatDuration(env.WORKER_HEARTBEAT_STALE_MS)}). Any job it was holding will be requeued
          once its claim lease expires — use the recovery sweep to do that now. No replacement worker
          is started automatically.
        </Callout>
      ) : null}

      {holder ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Lease holder</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <DetailRow label="Name">{holder.name}</DetailRow>
              <DetailRow label="Host">{holder.hostname}</DetailRow>
              <DetailRow label="Status">
                <WorkerStatusBadge status={holder.status} healthy={holder.healthy} />
              </DetailRow>
              <DetailRow label="Browser">
                <Badge variant={holder.browserStatus === 'OPEN' ? 'success' : 'muted'}>
                  {holder.browserStatus}
                </Badge>
              </DetailRow>
              <DetailRow label="Session">
                <SessionStatusBadge status={holder.sessionStatus} />
              </DetailRow>
              <DetailRow label="Last heartbeat">
                {formatRelativeTime(holder.lastHeartbeatAt)} (
                {formatDuration(holder.heartbeatAgeMs)} ago)
              </DetailRow>
              <DetailRow label="Current job">
                {holder.currentJobId ? (
                  <code className="font-mono text-xs">{holder.currentJobId}</code>
                ) : (
                  'idle'
                )}
              </DetailRow>
              <DetailRow label="Jobs processed">
                <span className="tabular">{formatNumber(holder.jobsProcessed)}</span>
              </DetailRow>
              <DetailRow label="Jobs failed">
                <span className="tabular">{formatNumber(holder.jobsFailed)}</span>
              </DetailRow>
              {holder.lastError ? (
                <DetailRow label="Last error">
                  <span className="text-destructive text-xs">{holder.lastError}</span>
                </DetailRow>
              ) : null}
              <DetailRow label="Automation">
                <Badge variant={system.killSwitchEngaged ? 'danger' : 'success'}>
                  {system.killSwitchEngaged ? 'STOPPED' : 'Permitted'}
                </Badge>
              </DetailRow>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {processingJobs.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">In flight</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Claim expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processingJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">{job.lead.fullName}</TableCell>
                    <TableCell className="text-xs">{job.campaign.name}</TableCell>
                    <TableCell className="text-xs">{job.claimedBy?.name ?? 'unknown'}</TableCell>
                    <TableCell className="text-xs">
                      {job.startedAt ? formatRelativeTime(job.startedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {job.claimExpiresAt ? formatRelativeTime(job.claimExpiresAt) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Worker history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {workers.length === 0 ? (
            <EmptyState
              icon={<Cpu className="size-6" />}
              title="No worker has ever registered"
              description="Start one with npm run worker."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Host / PID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Stopped</TableHead>
                  <TableHead className="text-right">Done</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Lease</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((worker) => (
                  <TableRow key={worker.id}>
                    <TableCell className="font-medium">{worker.name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {worker.hostname} / {worker.pid}
                    </TableCell>
                    <TableCell>
                      <WorkerStatusBadge status={worker.status} />
                    </TableCell>
                    <TableCell className="text-xs">{formatTimestamp(worker.startedAt)}</TableCell>
                    <TableCell className="text-xs">
                      {worker.stoppedAt ? formatTimestamp(worker.stoppedAt) : '—'}
                    </TableCell>
                    <TableCell className="tabular text-right">{worker.jobsProcessed}</TableCell>
                    <TableCell className="tabular text-right">{worker.jobsFailed}</TableCell>
                    <TableCell>
                      {system.activeWorkerId === worker.id ? (
                        <Badge variant="success">Holder</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How the lease works</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>
            A worker calls <code className="font-mono text-xs">/api/worker/register</code> on start
            up. If another worker holds the lease and its heartbeat is fresher than{' '}
            {formatDuration(env.WORKER_HEARTBEAT_STALE_MS)}, registration is refused.
          </p>
          <p>
            A stale lease is reclaimed automatically, because the previous holder is demonstrably
            gone. A live lease is only taken with an explicit{' '}
            <code className="font-mono text-xs">npm run worker -- --force-takeover</code>.
          </p>
          <p>
            If a worker loses the lease while running, it notices on its next heartbeat and shuts
            itself down rather than continuing to send.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
