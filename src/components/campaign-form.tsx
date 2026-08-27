'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Field, Label } from '@/components/ui/label';
import { Callout } from '@/components/ui/misc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { clockToMinutes, minutesToClock } from '@/lib/utils';
import { createCampaign, updateCampaign } from '@/server/actions/campaigns';

/**
 * Campaign create/edit form.
 *
 * Deliberately does not offer an "activate" toggle: activation is a separate,
 * confirmed action on the campaign page, so a campaign can never start running
 * as a side effect of saving a form.
 */

const NONE = '__none__';

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
] as const;

const COMMON_TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Warsaw',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
];

export interface CampaignFormValues {
  id?: string;
  name: string;
  description: string;
  messageTemplateId: string | null;
  timezone: string;
  dailyLimit: number;
  windowStartMinute: number;
  windowEndMinute: number;
  operatingDays: number[];
  minActionDelaySeconds: number;
  maxActionDelaySeconds: number;
  maxAttemptsPerLead: number;
  pauseOnIncident: boolean;
  skipLeadsMissingTemplateVars: boolean;
}

export function CampaignForm({
  initial,
  templates,
  globalDailyLimit,
  disabled,
  disabledReason,
}: {
  initial: CampaignFormValues;
  templates: { id: string; name: string }[];
  globalDailyLimit: number;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const isEdit = !!initial.id;

  const [values, setValues] = React.useState<CampaignFormValues>(initial);
  const [startClock, setStartClock] = React.useState(minutesToClock(initial.windowStartMinute));
  const [endClock, setEndClock] = React.useState(minutesToClock(initial.windowEndMinute));
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  function set<K extends keyof CampaignFormValues>(key: K, value: CampaignFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleDay(day: number) {
    set(
      'operatingDays',
      values.operatingDays.includes(day)
        ? values.operatingDays.filter((d) => d !== day)
        : [...values.operatingDays, day].sort((a, b) => a - b),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    const startMinute = clockToMinutes(startClock);
    const endMinute = clockToMinutes(endClock);

    if (startMinute === null || endMinute === null) {
      setErrors({
        ...(startMinute === null ? { windowStartMinute: 'Use HH:MM, e.g. 09:00' } : {}),
        ...(endMinute === null ? { windowEndMinute: 'Use HH:MM, e.g. 17:00' } : {}),
      });
      return;
    }

    const payload = {
      ...(isEdit ? { id: initial.id } : {}),
      name: values.name,
      description: values.description || null,
      messageTemplateId: values.messageTemplateId,
      settings: {
        timezone: values.timezone,
        dailyLimit: values.dailyLimit,
        windowStartMinute: startMinute,
        windowEndMinute: endMinute,
        operatingDays: values.operatingDays,
        minActionDelaySeconds: values.minActionDelaySeconds,
        maxActionDelaySeconds: values.maxActionDelaySeconds,
        maxAttemptsPerLead: values.maxAttemptsPerLead,
        pauseOnIncident: values.pauseOnIncident,
        skipLeadsMissingTemplateVars: values.skipLeadsMissingTemplateVars,
      },
    };

    setPending(true);
    try {
      const result = isEdit ? await updateCampaign(payload) : await createCampaign(payload);

      if (result.ok) {
        toast.success(result.message ?? 'Saved.');
        router.push(`/campaigns/${result.data.id}`);
        router.refresh();
        return;
      }

      setFormError(result.error);
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.issues ?? []) {
        fieldErrors[issue.field.replace('settings.', '')] = issue.message;
      }
      setErrors(fieldErrors);
    } catch {
      setFormError('Could not save the campaign.');
    } finally {
      setPending(false);
    }
  }

  const effectiveLimit = Math.min(values.dailyLimit, globalDailyLimit);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {disabled ? (
        <Callout tone="warning" title="This campaign cannot be edited right now">
          {disabledReason}
        </Callout>
      ) : null}

      {formError ? (
        <Callout tone="danger" title="Could not save">
          {formError}
        </Callout>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Identity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input
              id="name"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Q3 CRA outreach"
              disabled={disabled}
              maxLength={150}
            />
          </Field>

          <Field label="Description" htmlFor="description" error={errors.description}>
            <Textarea
              id="description"
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What this campaign is for, and who is on the list."
              disabled={disabled}
              maxLength={1000}
            />
          </Field>

          <Field
            label="Connection note template"
            hint="Optional. With no template, invitations are sent without a note."
            error={errors.messageTemplateId}
          >
            <Select
              value={values.messageTemplateId ?? NONE}
              onValueChange={(value) => set('messageTemplateId', value === NONE ? null : value)}
              disabled={disabled}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue placeholder="No note" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No note</SelectItem>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Schedule</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Timezone" error={errors.timezone}>
              <Select
                value={values.timezone}
                onValueChange={(value) => set('timezone', value)}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Window opens"
              htmlFor="start"
              error={errors.windowStartMinute}
              hint="Local time"
            >
              <Input
                id="start"
                value={startClock}
                onChange={(e) => setStartClock(e.target.value)}
                placeholder="09:00"
                disabled={disabled}
              />
            </Field>

            <Field
              label="Window closes"
              htmlFor="end"
              error={errors.windowEndMinute}
              hint="Local time"
            >
              <Input
                id="end"
                value={endClock}
                onChange={(e) => setEndClock(e.target.value)}
                placeholder="17:00"
                disabled={disabled}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Operating days</Label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const on = values.operatingDays.includes(day.value);
                return (
                  <Button
                    key={day.value}
                    type="button"
                    variant={on ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleDay(day.value)}
                    disabled={disabled}
                    aria-pressed={on}
                  >
                    {day.label}
                  </Button>
                );
              })}
            </div>
            {errors.operatingDays ? (
              <p className="text-destructive text-xs font-medium">{errors.operatingDays}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                With no days selected the campaign can never run.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Limits and pacing</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Daily limit"
              htmlFor="dailyLimit"
              error={errors.dailyLimit}
              hint={`Global ceiling ${globalDailyLimit}/day`}
            >
              <Input
                id="dailyLimit"
                type="number"
                min={1}
                max={100}
                value={values.dailyLimit}
                onChange={(e) => set('dailyLimit', Number(e.target.value))}
                disabled={disabled}
              />
            </Field>

            <Field
              label="Min delay (seconds)"
              htmlFor="minDelay"
              error={errors.minActionDelaySeconds}
            >
              <Input
                id="minDelay"
                type="number"
                min={5}
                max={3600}
                value={values.minActionDelaySeconds}
                onChange={(e) => set('minActionDelaySeconds', Number(e.target.value))}
                disabled={disabled}
              />
            </Field>

            <Field
              label="Max delay (seconds)"
              htmlFor="maxDelay"
              error={errors.maxActionDelaySeconds}
            >
              <Input
                id="maxDelay"
                type="number"
                min={5}
                max={7200}
                value={values.maxActionDelaySeconds}
                onChange={(e) => set('maxActionDelaySeconds', Number(e.target.value))}
                disabled={disabled}
              />
            </Field>

            <Field
              label="Retries per lead"
              htmlFor="maxAttempts"
              error={errors.maxAttemptsPerLead}
              hint="Technical failures only"
            >
              <Input
                id="maxAttempts"
                type="number"
                min={1}
                max={10}
                value={values.maxAttemptsPerLead}
                onChange={(e) => set('maxAttemptsPerLead', Number(e.target.value))}
                disabled={disabled}
              />
            </Field>
          </div>

          {values.dailyLimit > globalDailyLimit ? (
            <Callout tone="info" title="The global limit applies">
              This campaign asks for {values.dailyLimit}/day, but the global ceiling is{' '}
              {globalDailyLimit}/day, so at most {effectiveLimit} actions will run. Raise{' '}
              <code className="font-mono text-xs">GLOBAL_DAILY_ACTION_LIMIT</code> if you really
              want more.
            </Callout>
          ) : null}

          <label className="flex items-start gap-3">
            <Switch
              checked={values.pauseOnIncident}
              onCheckedChange={(checked) => set('pauseOnIncident', checked)}
              disabled={disabled}
            />
            <span className="text-sm">
              Pause this campaign as soon as an incident is opened against it
              <span className="text-muted-foreground block text-xs">
                Recommended. Turning this off means one bad profile will not stop the campaign, but
                a real problem takes longer to notice.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <Switch
              checked={values.skipLeadsMissingTemplateVars}
              onCheckedChange={(checked) => set('skipLeadsMissingTemplateVars', checked)}
              disabled={disabled}
            />
            <span className="text-sm">
              Skip leads whose note cannot be filled in
              <span className="text-muted-foreground block text-xs">
                Recommended. With this off, a lead missing a first name gets an invitation with no
                note rather than being skipped.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || disabled}>
          {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create as draft'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        {!isEdit ? (
          <p className="text-muted-foreground text-xs">
            Created as a DRAFT. Nothing runs until you activate it.
          </p>
        ) : null}
      </div>
    </form>
  );
}
