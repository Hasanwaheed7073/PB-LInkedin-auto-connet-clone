'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { ListPlus, Pause, Play, Rocket } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { formatNumber } from '@/lib/utils';
import {
  activateCampaign,
  generateCampaignQueue,
  pauseCampaign,
  resumeCampaign,
} from '@/server/actions/campaigns';

/**
 * Activate / pause / resume, plus queue generation.
 *
 * Activation and pausing both go through a confirmation dialog. Activation is
 * the only path to RUNNING and the dialog spells out exactly what will happen,
 * because it is the action that starts contacting real people.
 */
export function CampaignControls({
  campaignId,
  campaignName,
  status,
  active,
  canActivate,
  pendingLeads,
  waitingJobs,
}: {
  campaignId: string;
  campaignName: string;
  status: string;
  active: boolean;
  canActivate: boolean;
  pendingLeads: number;
  waitingJobs: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [pauseReason, setPauseReason] = React.useState('');
  const [activateOpen, setActivateOpen] = React.useState(false);
  const [pauseOpen, setPauseOpen] = React.useState(false);

  const isRunning = active && status === 'RUNNING';
  const isPaused = status === 'PAUSED';
  const isFinished = status === 'COMPLETED';

  async function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setPending(true);
    try {
      const result = await action();
      if (result.ok) {
        toast.success(result.message ?? 'Done.');
        router.refresh();
        return true;
      }
      toast.error(result.error ?? 'That did not work.', { duration: 8_000 });
      return false;
    } catch {
      toast.error('Could not reach the server.');
      return false;
    } finally {
      setPending(false);
    }
  }

  if (isFinished) {
    return (
      <p className="text-muted-foreground text-sm">
        This campaign is complete. Create a new one rather than restarting it.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || pendingLeads === 0}
        onClick={() =>
          void run(() => generateCampaignQueue({ campaignId }))
        }
        className="gap-1.5"
        title={
          pendingLeads === 0
            ? 'No pending leads to queue'
            : `Queue up to ${pendingLeads} pending lead(s)`
        }
      >
        <ListPlus className="size-3.5" />
        Generate queue
      </Button>

      {isRunning ? (
        <AlertDialog open={pauseOpen} onOpenChange={setPauseOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Pause className="size-3.5" />
              Pause
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Pause “{campaignName}”?</AlertDialogTitle>
              <AlertDialogDescription>
                No new jobs will start. The {formatNumber(waitingJobs)} waiting job(s) stay queued,
                so resuming picks up where it left off. A job the worker is already running will
                finish and report normally.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field label="Reason (optional, recorded in the audit log)" htmlFor="pause-reason">
              <Input
                id="pause-reason"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="Why are you pausing?"
                maxLength={500}
              />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(event) => {
                  event.preventDefault();
                  void run(() =>
                    pauseCampaign({ id: campaignId, reason: pauseReason.trim() || undefined }),
                  ).then((ok) => {
                    if (ok) {
                      setPauseOpen(false);
                      setPauseReason('');
                    }
                  });
                }}
              >
                {pending ? 'Pausing…' : 'Pause campaign'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {isPaused ? (
        <Button
          size="sm"
          disabled={pending || !canActivate}
          onClick={() => void run(() => resumeCampaign({ id: campaignId }))}
          className="gap-1.5"
          title={canActivate ? undefined : 'Pre-flight checks are failing'}
        >
          <Play className="size-3.5" />
          Resume
        </Button>
      ) : null}

      {!isRunning && !isPaused ? (
        <AlertDialog open={activateOpen} onOpenChange={setActivateOpen}>
          <AlertDialogTrigger asChild>
            <Button size="sm" disabled={pending || !canActivate} className="gap-1.5">
              <Rocket className="size-3.5" />
              Activate
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Activate “{campaignName}”?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    This will start sending real connection requests to real people, as soon as the
                    campaign is inside its operating window and a worker is running.
                  </p>
                  <p>
                    {formatNumber(pendingLeads)} pending lead(s) will be queued and spread across
                    the operating window, within the configured daily limit.
                  </p>
                  <p>
                    You can pause at any time, and the emergency stop halts everything within
                    seconds.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(event) => {
                  event.preventDefault();
                  void run(() =>
                    activateCampaign({ id: campaignId, confirm: true, generateQueue: true }),
                  ).then((ok) => {
                    if (ok) setActivateOpen(false);
                  });
                }}
              >
                {pending ? 'Activating…' : 'Activate and queue'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {!canActivate && !isRunning ? (
        <span className="text-muted-foreground text-xs">
          Resolve the failing pre-flight checks first.
        </span>
      ) : null}
    </div>
  );
}
