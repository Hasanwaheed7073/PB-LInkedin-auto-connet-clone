'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { Briefcase, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { formatNumber } from '@/lib/utils';
import { createBusinessProfile, selectBusinessProfile } from '@/server/actions/business';

export interface ChooserProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  badge: string | null;
  icpProfile: string | null;
  campaigns: number;
  leads: number;
}

/**
 * Pick which business to work on.
 *
 * Shown after sign-in when nothing is selected. The choice is a view filter,
 * not a permission boundary - the daily ceilings, the queue and the duplicate
 * guard are shared across every business, because they protect one LinkedIn
 * account. That is stated on the page rather than left to be discovered.
 */
export function BusinessChooser({ profiles }: { profiles: ChooserProfile[] }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [icpProfile, setIcpProfile] = React.useState('');

  async function choose(slug: string) {
    setPending(slug);
    try {
      const result = await selectBusinessProfile({ slug });
      if (result.ok) {
        router.push('/');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setPending(null);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setPending('new');
    try {
      const result = await createBusinessProfile({
        name,
        description: description || undefined,
        icpProfile: icpProfile || undefined,
      });
      if (result.ok) {
        toast.success(result.message ?? 'Created.');
        setName('');
        setDescription('');
        setIcpProfile('');
        setCreating(false);
        await choose(result.data.slug);
      } else {
        toast.error(result.error);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-6">
      <div>
        <h1 className="text-lg font-semibold">Which business are you working on?</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          This filters what you see. The daily limits, the queue and the duplicate protection are
          shared across every business, because they protect one LinkedIn account.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {profiles.map((profile) => (
          <Card key={profile.id} className="hover:border-primary/60 transition-colors">
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex items-start gap-3">
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold">
                  {profile.badge ?? <Briefcase className="size-4" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{profile.name}</p>
                  {profile.description ? (
                    <p className="text-muted-foreground line-clamp-2 text-xs">
                      {profile.description}
                    </p>
                  ) : null}
                </div>
              </div>

              <p className="text-muted-foreground text-xs tabular">
                {formatNumber(profile.campaigns)} campaign(s) · {formatNumber(profile.leads)} lead(s)
                {profile.icpProfile ? ` · ${profile.icpProfile}` : ''}
              </p>

              <Button
                size="sm"
                disabled={pending !== null}
                onClick={() => void choose(profile.slug)}
              >
                {pending === profile.slug ? 'Opening…' : 'Work on this'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {creating ? (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={create} className="flex flex-col gap-3">
              <Field label="Business name" htmlFor="bp-name">
                <Input
                  id="bp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Healthcare — Clinical Research"
                  required
                  minLength={2}
                />
              </Field>
              <Field label="What it is (optional)" htmlFor="bp-desc">
                <Input
                  id="bp-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Who these leads are and what you offer them"
                />
              </Field>
              <Field label="ICP file (optional)" htmlFor="bp-icp">
                <Input
                  id="bp-icp"
                  value={icpProfile}
                  onChange={(e) => setIcpProfile(e.target.value)}
                  placeholder="icp/clinical-research-us.json"
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={pending !== null || name.trim().length < 2}>
                  {pending === 'new' ? 'Creating…' : 'Create and open'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCreating(false)}
                  disabled={pending !== null}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit gap-1.5"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          New business
        </Button>
      )}

      {profiles.length === 0 && !creating ? (
        <p className="text-muted-foreground text-sm">
          No businesses yet. Create one to get started.
        </p>
      ) : null}
    </div>
  );
}
