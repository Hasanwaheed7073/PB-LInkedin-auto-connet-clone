'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';
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
import { scheduleBurstAction } from '@/server/actions/campaigns';

/**
 * The daily control: "send this many, over this long, starting now."
 *
 * Exists so the everyday decision does not require editing the campaign's
 * schedule or touching a terminal. It moves waiting jobs forward and lets the
 * worker run outside the operating window until the burst expires - the window
 * describes a standing rhythm, and this is an explicit instruction for now.
 *
 * It cannot exceed a daily limit. Those are enforced server-side against what
 * has actually been sent today, and trim the request rather than refusing it.
 */
export function SendBurst({
  campaignId,
  waitingJobs,
  canSend,
  disabledReason,
}: {
  campaignId: string;
  waitingJobs: number;
  canSend: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [count, setCount] = React.useState('10');
  const [minutes, setMinutes] = React.useState('30');
  const [pending, setPending] = React.useState(false);

  const parsedCount = Number(count);
  const parsedMinutes = Number(minutes);
  const valid =
    Number.isFinite(parsedCount) &&
    parsedCount >= 1 &&
    Number.isFinite(parsedMinutes) &&
    parsedMinutes >= 1;

  const everyMinutes =
    valid && parsedCount > 0 ? Math.max(0.25, parsedMinutes / parsedCount) : 0;

  async function onConfirm() {
    setPending(true);
    try {
      const result = await scheduleBurstAction({
        campaignId,
        count: parsedCount,
        minutes: parsedMinutes,
      });

      if (result.ok) {
        toast.success(result.message ?? `${result.data.scheduled} scheduled.`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Could not schedule the burst.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!canSend || waitingJobs === 0}
          title={
            !canSend
              ? (disabledReason ?? 'Campaign must be running')
              : waitingJobs === 0
                ? 'No leads waiting in the queue'
                : `${waitingJobs} lead(s) waiting`
          }
        >
          <Send className="size-3.5" />
          Send now
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send a batch now</AlertDialogTitle>
          <AlertDialogDescription>
            Brings invitations forward and spreads them over the time you choose. This runs even
            outside the campaign&rsquo;s operating hours, so it is a deliberate instruction rather
            than a schedule change.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="How many" htmlFor="burst-count">
            <Input
              id="burst-count"
              type="number"
              min={1}
              max={200}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </Field>
          <Field label="Over how many minutes" htmlFor="burst-minutes">
            <Input
              id="burst-minutes"
              type="number"
              min={1}
              max={720}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        </div>

        <div className="text-muted-foreground space-y-1 text-xs">
          {valid ? (
            <p>
              Roughly one invitation every{' '}
              <span className="text-foreground tabular">
                {everyMinutes >= 1
                  ? `${everyMinutes.toFixed(1)} minutes`
                  : `${Math.round(everyMinutes * 60)} seconds`}
              </span>
              . {waitingJobs} lead(s) are waiting.
            </p>
          ) : (
            <p>Enter a count and a duration.</p>
          )}
          <p>
            Your daily limits still apply — the request is trimmed to fit rather than exceeding
            them.
          </p>
          <p className="text-warning">
            The worker must be running for these to go out. Scheduling alone sends nothing.
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !valid}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
          >
            {pending ? 'Scheduling…' : `Schedule ${valid ? parsedCount : ''}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
