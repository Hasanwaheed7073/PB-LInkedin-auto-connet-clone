'use client';

import * as React from 'react';

import { AlertTriangle, OctagonX, ShieldCheck } from 'lucide-react';
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
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { clearEmergencyStopAction, emergencyStopAll } from '@/server/actions/safety';

/**
 * STOP ALL AUTOMATION.
 *
 * Deliberately the loudest control in the interface, and deliberately behind a
 * confirmation dialog that requires a reason - the reason goes into the audit
 * log, and an unexplained stop is worse than no record at all.
 */
export function EmergencyStopButton({
  engaged,
  reason,
  size = 'default',
}: {
  engaged: boolean;
  reason?: string | null;
  size?: 'default' | 'sm' | 'lg' | 'xl';
}) {
  const [open, setOpen] = React.useState(false);
  const [stopReason, setStopReason] = React.useState('');
  const [pending, setPending] = React.useState(false);

  if (engaged) {
    return <ClearEmergencyStopButton reason={reason} size={size} />;
  }

  async function submit() {
    const trimmed = stopReason.trim();
    if (trimmed.length === 0) {
      toast.error('A reason is required so the audit log records why automation was stopped.');
      return;
    }

    setPending(true);
    try {
      const result = await emergencyStopAll({ confirm: true, reason: trimmed });
      if (result.ok) {
        toast.success(result.message ?? 'All automation stopped.');
        setOpen(false);
        setStopReason('');
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Could not reach the server. Automation may still be running - retry.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size={size} className="gap-2 font-semibold">
          <OctagonX className="size-4" />
          STOP ALL
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <OctagonX className="text-destructive size-5" />
            Stop all automation
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>This immediately:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>stops the worker and aborts the action it is performing</li>
                <li>pauses every active campaign</li>
                <li>cancels waiting queue jobs</li>
                <li>blocks any new job from starting</li>
              </ul>
              <p>
                Work already recorded is preserved. A job the worker is mid-way through is left
                alone so its real outcome is not lost - it will be requeued if the worker never
                reports back.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field
          label="Reason (recorded in the audit log)"
          htmlFor="stop-reason"
          hint="For example: LinkedIn showed a warning, or wrong lead list activated."
        >
          <Input
            id="stop-reason"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
            placeholder="Why are you stopping automation?"
            autoFocus
            maxLength={500}
          />
        </Field>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              // Keep the dialog open so a failure is visible rather than
              // dismissing and leaving the operator unsure whether it worked.
              event.preventDefault();
              void submit();
            }}
          >
            {pending ? 'Stopping…' : 'Stop all automation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Clear the stop.
 *
 * The server refuses while any blocking incident is unresolved, and this dialog
 * says so plainly rather than presenting clearing as routine.
 */
function ClearEmergencyStopButton({
  reason,
  size = 'default',
}: {
  reason?: string | null;
  size?: 'default' | 'sm' | 'lg' | 'xl';
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function submit() {
    setPending(true);
    try {
      const result = await clearEmergencyStopAction({ confirm: true });
      if (result.ok) {
        toast.success(result.message ?? 'Emergency stop cleared.');
        setOpen(false);
      } else {
        toast.error(result.error, { duration: 8_000 });
      }
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size={size} className="border-warning/50 text-warning gap-2">
          <ShieldCheck className="size-4" />
          Clear stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-warning size-5" />
            Clear the emergency stop
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {reason ? (
                <p>
                  Automation was stopped because: <span className="text-foreground">{reason}</span>
                </p>
              ) : null}
              <p>
                Clearing the stop does <strong>not</strong> restart anything. Every campaign stays
                paused and has to be activated again deliberately.
              </p>
              <p>
                This is refused while any incident still requires human action - deal with those
                first.
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
              void submit();
            }}
          >
            {pending ? 'Clearing…' : 'Clear stop'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
