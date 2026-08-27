import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Callout, DetailRow, NotImplemented } from '@/components/ui/misc';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getSystemState } from '@/lib/safety';
import { formatDuration, formatNumber, formatTimestamp } from '@/lib/utils';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/**
 * Settings.
 *
 * Read-only on purpose. Everything here comes from environment variables, and
 * changing a safety limit is a deliberate act that should go through the `.env`
 * file and a restart rather than a text box in a web UI. Showing them here means
 * an operator can confirm what is actually in force.
 *
 * No secret value is rendered - only whether it is configured.
 */
export default async function SettingsPage() {
  const env = serverEnv();

  const [user, system, counts] = await Promise.all([
    currentUser(),
    getSystemState(),
    Promise.all([
      prisma.lead.count(),
      prisma.campaign.count(),
      prisma.queueJob.count(),
      prisma.activityLog.count(),
      prisma.incident.count(),
      prisma.worker.count(),
    ]),
  ]);

  const [leads, campaigns, jobs, logs, incidents, workers] = counts;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Configuration in force. Safety limits live in <code className="font-mono">.env</code> and
          take effect on restart.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Safety limits</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <DetailRow label="Global daily action limit">
              <span className="tabular">{formatNumber(env.GLOBAL_DAILY_ACTION_LIMIT)}/day</span>
            </DetailRow>
            <DetailRow label="Max connection-note length">
              <span className="tabular">{env.MAX_CONNECTION_NOTE_CHARS} characters</span>
            </DetailRow>
            <DetailRow label="Heartbeat stale threshold">
              {formatDuration(env.WORKER_HEARTBEAT_STALE_MS)}
            </DetailRow>
            <DetailRow label="Emergency stop">
              <Badge variant={system.killSwitchEngaged ? 'danger' : 'success'}>
                {system.killSwitchEngaged ? 'ENGAGED' : 'Not engaged'}
              </Badge>
            </DetailRow>
            {system.killSwitchEngaged ? (
              <>
                <DetailRow label="Stopped because">
                  {system.killSwitchReason ?? 'no reason recorded'}
                </DetailRow>
                <DetailRow label="Stopped by">{system.killSwitchEngagedBy ?? 'unknown'}</DetailRow>
                <DetailRow label="Stopped at">
                  {system.killSwitchEngagedAt
                    ? formatTimestamp(system.killSwitchEngagedAt)
                    : 'unknown'}
                </DetailRow>
              </>
            ) : null}
            <DetailRow label="Control epoch">
              <span className="tabular">{system.controlEpoch}</span>
            </DetailRow>
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            The global limit applies on top of each campaign&rsquo;s own daily limit; the lower of
            the two always wins, so adding campaigns cannot increase total volume.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Secrets</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <DetailRow label="Database URL">
              <Badge variant="success">Configured</Badge>
            </DetailRow>
            <DetailRow label="Session secret">
              <Badge variant="success">Configured</Badge>
            </DetailRow>
            <DetailRow label="Worker API token">
              <Badge variant="success">Configured</Badge>
            </DetailRow>
            <DetailRow label="LinkedIn credentials">
              <Badge variant="muted">Never stored</Badge>
            </DetailRow>
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            Values are never rendered here, sent to the browser, or written to the activity log.
            This application does not accept a LinkedIn username or password anywhere — the browser
            session is authenticated by hand with{' '}
            <code className="font-mono">npm run worker -- --login</code> and lives only in the
            persistent browser profile on disk.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Operator</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <DetailRow label="Name">{user?.name ?? '—'}</DetailRow>
            <DetailRow label="Email">{user?.email ?? '—'}</DetailRow>
            <DetailRow label="Role">{user?.role ?? '—'}</DetailRow>
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            Change the password by updating <code className="font-mono">SEED_USER_PASSWORD</code>{' '}
            and re-running <code className="font-mono">npm run db:seed</code>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Database contents</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <DetailRow label="Leads">
              <span className="tabular">{formatNumber(leads)}</span>
            </DetailRow>
            <DetailRow label="Campaigns">
              <span className="tabular">{formatNumber(campaigns)}</span>
            </DetailRow>
            <DetailRow label="Queue jobs">
              <span className="tabular">{formatNumber(jobs)}</span>
            </DetailRow>
            <DetailRow label="Activity records">
              <span className="tabular">{formatNumber(logs)}</span>
            </DetailRow>
            <DetailRow label="Incidents">
              <span className="tabular">{formatNumber(incidents)}</span>
            </DetailRow>
            <DetailRow label="Workers registered">
              <span className="tabular">{formatNumber(workers)}</span>
            </DetailRow>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Not implemented</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <NotImplemented
            what="MESSAGE, FOLLOW and PROFILE_VISIT actions"
            why="They exist in the queue schema so adding them needs no migration, but the worker has no implementation and refuses such a job rather than pretending to run it."
          />
          <NotImplemented
            what="Editing safety limits from the UI"
            why="Daily limits and the note-length ceiling are read from environment variables. A safety limit should not be changeable by a mis-click; edit .env and restart."
          />
          <NotImplemented
            what="Multiple concurrent workers"
            why="Deliberately excluded. A second worker could double-send, so registration is refused while another holds the run lease."
          />
        </CardContent>
      </Card>

      <Callout tone="info" title="What this system will not do">
        <p>
          It does not solve CAPTCHAs, spoof browser fingerprints, rotate proxies, use stealth
          plugins, or attempt to get around any LinkedIn rate limit or security check. When a
          challenge, restriction or unrecognised page appears, the worker stops and waits for a
          person.
        </p>
      </Callout>
    </div>
  );
}
