'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { ArrowUp, MoreHorizontal, RotateCw, XCircle } from 'lucide-react';
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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cancelQueueJob, expediteQueueJob, requeueJob } from '@/server/actions/queue';

/**
 * Per-job operator actions.
 *
 * A PROCESSING job offers nothing: it is owned by a worker holding a claim
 * token, and rewriting it from here would race the worker. The emergency stop is
 * the way to interrupt live work.
 */
export function QueueJobActions({
  jobId,
  status,
  leadName,
}: {
  jobId: string;
  status: string;
  leadName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  const canCancel = status === 'WAITING' || status === 'REQUIRES_REVIEW';
  const canExpedite = status === 'WAITING';
  const canRequeue = status === 'REQUIRES_REVIEW' || status === 'FAILED';

  if (!canCancel && !canExpedite && !canRequeue) {
    return (
      <span className="text-muted-foreground text-xs">
        {status === 'PROCESSING' ? 'Running' : '—'}
      </span>
    );
  }

  async function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setPending(true);
    try {
      const result = await action();
      if (result.ok) {
        toast.success(result.message ?? 'Done.');
        router.refresh();
      } else {
        toast.error(result.error ?? 'That did not work.', { duration: 8_000 });
      }
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" disabled={pending} aria-label={`Actions for ${leadName}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canExpedite ? (
            <DropdownMenuItem onClick={() => void run(() => expediteQueueJob(jobId))}>
              <ArrowUp className="size-4" />
              Move to front
            </DropdownMenuItem>
          ) : null}
          {canRequeue ? (
            <DropdownMenuItem onClick={() => void run(() => requeueJob(jobId))}>
              <RotateCw className="size-4" />
              Requeue
            </DropdownMenuItem>
          ) : null}
          {canCancel ? (
            <DropdownMenuItem destructive onClick={() => setConfirmCancel(true)}>
              <XCircle className="size-4" />
              Cancel job
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the job for {leadName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The job is cancelled and the lead returns to PENDING, so it can be queued again
              later. Nothing is sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void run(() => cancelQueueJob({ id: jobId })).then(() => setConfirmCancel(false));
              }}
            >
              {pending ? 'Cancelling…' : 'Cancel job'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
