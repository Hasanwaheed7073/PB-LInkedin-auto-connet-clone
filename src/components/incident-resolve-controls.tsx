'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { Check, Eye, Play, RotateCw, SkipForward, Ban, OctagonX } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { acknowledgeIncident, resolveIncident } from '@/server/actions/safety';

type Action = 'RESUME' | 'SKIP_LEAD' | 'BLOCK_LEAD' | 'REQUEUE_LEAD' | 'STOP_CAMPAIGN';

/**
 * Resolution controls for one incident.
 *
 * The three actions the specification asks for - resume the worker, skip the
 * lead, stop the campaign - plus block and requeue for the lead. Resolving never
 * clears the emergency stop; that stays a separate deliberate action, spelled
 * out here so the operator is not surprised.
 */
export function IncidentResolveControls({
  incidentId,
  status,
  hasLead,
  hasCampaign,
  leadName,
  blocksWorker,
}: {
  incidentId: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  hasLead: boolean;
  hasCampaign: boolean;
  leadName: string | null;
  blocksWorker: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = React.useState('');
  const [pending, setPending] = React.useState<Action | 'ACK' | null>(null);

  async function resolve(action: Action) {
    setPending(action);
    try {
      const result = await resolveIncident({
        incidentId,
        action,
        note: note.trim() || null,
      });
      if (result.ok) {
        toast.success(result.message ?? 'Incident resolved.', { duration: 7_000 });
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  async function acknowledge() {
    setPending('ACK');
    try {
      const result = await acknowledgeIncident({ incidentId });
      if (result.ok) {
        toast.success('Acknowledged.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <Field
        label="Resolution note (optional)"
        htmlFor={`note-${incidentId}`}
        hint="Recorded in the audit log alongside the action you take."
      >
        <Input
          id={`note-${incidentId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What did you find, and what did you do?"
          maxLength={2000}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        {status === 'OPEN' ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void acknowledge()}
            disabled={busy}
            className="gap-1.5"
          >
            <Eye className="size-3.5" />
            Acknowledge
          </Button>
        ) : null}

        <Button
          size="sm"
          onClick={() => void resolve('RESUME')}
          disabled={busy}
          className="gap-1.5"
          title="Mark resolved and leave the lead as it is"
        >
          <Play className="size-3.5" />
          {pending === 'RESUME' ? 'Resolving…' : 'Resolve — resume worker'}
        </Button>

        {hasLead ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resolve('SKIP_LEAD')}
              disabled={busy}
              className="gap-1.5"
            >
              <SkipForward className="size-3.5" />
              Skip {leadName ? leadName.split(' ')[0] : 'lead'}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void resolve('REQUEUE_LEAD')}
              disabled={busy}
              className="gap-1.5"
            >
              <RotateCw className="size-3.5" />
              Requeue lead
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void resolve('BLOCK_LEAD')}
              disabled={busy}
              className="border-destructive/40 text-destructive gap-1.5"
            >
              <Ban className="size-3.5" />
              Block lead
            </Button>
          </>
        ) : null}

        {hasCampaign ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resolve('STOP_CAMPAIGN')}
            disabled={busy}
            className="border-destructive/40 text-destructive gap-1.5"
          >
            <OctagonX className="size-3.5" />
            Stop campaign
          </Button>
        ) : null}
      </div>

      {blocksWorker ? (
        <p className="text-muted-foreground text-xs">
          <Check className="mr-1 inline size-3" />
          Resolving this releases the worker gate. If the emergency stop is also engaged, clear it
          separately — that is deliberate, so a security check cannot be dismissed in one click.
        </p>
      ) : null}
    </div>
  );
}
