'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { runRecoverySweep } from '@/server/actions/safety';

/**
 * Recovery sweep.
 *
 * Requeues jobs abandoned by a dead worker and flags stale workers. Does not
 * start a worker - launching one automatically is the duplicate-send risk the
 * design rules out.
 */
export function RecoverySweepButton() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function run() {
    setPending(true);
    try {
      const result = await runRecoverySweep();
      if (result.ok) {
        toast.success(result.message ?? 'Sweep complete.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Could not run the recovery sweep.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void run()} disabled={pending} className="gap-1.5">
      <RotateCcw className="size-3.5" />
      {pending ? 'Sweeping…' : 'Recovery sweep'}
    </Button>
  );
}
