import Link from 'next/link';

import { AlertTriangle } from 'lucide-react';

import { EmergencyStopButton } from '@/components/emergency-stop';
import { SessionStatusBadge, WorkerStatusBadge } from '@/components/status-badges';
import { ThemeToggle } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/misc';
import { countIncidents } from '@/lib/incidents';
import { getSystemState } from '@/lib/safety';
import { formatRelativeTime } from '@/lib/utils';
import { summarizeWorkers } from '@/lib/workers';
import { SignOutButton } from '@/components/sign-out-button';
import { activeBusinessProfile } from '@/lib/business-profile';
import { MainNav } from '@/components/nav-link';

/**
 * Application shell.
 *
 * The header carries the three facts an operator needs at a glance from every
 * screen - worker health, browser session state, and whether automation is
 * stopped - plus the emergency stop itself. All read from the database on every
 * request; none of it is decorative.
 */

export async function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { name: string; email: string };
}) {
  const [system, workers, incidents, business] = await Promise.all([
    getSystemState(),
    summarizeWorkers(),
    countIncidents(),
    activeBusinessProfile(),
  ]);

  const holder = workers.leaseHolder;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Stopped-state banner: unmissable, on every page. */}
      {system.killSwitchEngaged ? (
        <div className="bg-destructive text-destructive-foreground px-4 py-2 text-center text-sm font-semibold">
          ALL AUTOMATION STOPPED
          {system.killSwitchReason ? ` — ${system.killSwitchReason}` : ''}
          {system.killSwitchEngagedAt
            ? ` (${formatRelativeTime(system.killSwitchEngagedAt)})`
            : ''}
        </div>
      ) : null}

      <header className="bg-card/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-xs font-bold">
              LO
            </span>
            <span className="hidden sm:inline">LinkedIn Outreach</span>
          </Link>

          {business ? (
            <Link
              href="/choose"
              className="border-border hover:bg-muted flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
              title="Switch business"
            >
              <span className="bg-muted text-muted-foreground rounded px-1 text-[10px] font-semibold">
                {business.badge ?? business.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="max-w-[10rem] truncate">{business.name}</span>
            </Link>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground hidden md:inline">Worker</span>
            {holder ? (
              <WorkerStatusBadge status={holder.status} healthy={holder.healthy} />
            ) : (
              <Badge variant="muted" className="gap-1.5">
                <StatusDot tone="muted" />
                Not running
              </Badge>
            )}

            <span className="text-muted-foreground hidden md:inline">Session</span>
            <SessionStatusBadge status={holder?.sessionStatus ?? 'UNKNOWN'} />

            {incidents.blocking > 0 ? (
              <Button asChild variant="outline" size="sm" className="border-destructive/50 text-destructive gap-1.5">
                <Link href="/incidents">
                  <AlertTriangle className="size-3.5" />
                  {incidents.blocking} need action
                </Link>
              </Button>
            ) : null}

            <ThemeToggle />
            <EmergencyStopButton
              engaged={system.killSwitchEngaged}
              reason={system.killSwitchReason}
              size="sm"
            />
          </div>
        </div>

        <MainNav />
      </header>

      <main className="flex-1 px-4 py-6">{children}</main>

      <footer className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs">
        <span>
          Signed in as {user.name} ({user.email})
        </span>
        <div className="flex items-center gap-3">
          <span>
            Automation {system.killSwitchEngaged ? 'STOPPED' : 'permitted'} · control epoch{' '}
            {system.controlEpoch}
          </span>
          <SignOutButton />
        </div>
      </footer>
    </div>
  );
}
