'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { Eye, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Callout } from '@/components/ui/misc';
import { formatNumber } from '@/lib/utils';
import {
  createTemplate,
  deleteTemplate,
  previewTemplate,
  updateTemplate,
  type TemplatePreviewPayload,
} from '@/server/actions/templates';

/**
 * Template editor with live preview against a real lead.
 *
 * The preview also reports how many leads in the database the template would
 * fail for, so a note that works for the previewed person but breaks for a third
 * of the list is caught before activation rather than during a run.
 */
export function TemplateEditor({
  mode,
  leadCount,
  template,
  lockedReason,
}: {
  mode: 'create' | 'edit';
  leadCount: number;
  template?: { id: string; name: string; description: string; body: string };
  lockedReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(mode === 'create' ? false : false);
  const [name, setName] = React.useState(template?.name ?? '');
  const [description, setDescription] = React.useState(template?.description ?? '');
  const [body, setBody] = React.useState(template?.body ?? '');
  const [preview, setPreview] = React.useState<TemplatePreviewPayload | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Debounced preview as the body is typed.
  React.useEffect(() => {
    if (!open || body.trim().length === 0) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      setPreviewing(true);
      void previewTemplate({ body })
        .then((result) => {
          if (result.ok) setPreview(result.data);
          else setPreview(null);
        })
        .finally(() => setPreviewing(false));
    }, 450);

    return () => clearTimeout(handle);
  }, [body, open]);

  async function save() {
    setErrors({});
    setPending(true);
    try {
      const result =
        mode === 'edit' && template
          ? await updateTemplate({ id: template.id, name, description: description || null, body })
          : await createTemplate({ name, description: description || null, body });

      if (result.ok) {
        toast.success(result.message ?? 'Saved.');
        setOpen(false);
        if (mode === 'create') {
          setName('');
          setDescription('');
          setBody('');
        }
        router.refresh();
        return;
      }

      toast.error(result.error, { duration: 8_000 });
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.issues ?? []) fieldErrors[issue.field] = issue.message;
      setErrors(fieldErrors);
    } catch {
      toast.error('Could not save the template.');
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!template) return;
    setPending(true);
    try {
      const result = await deleteTemplate(template.id);
      if (result.ok) {
        toast.success('Template deleted.');
        router.refresh();
      } else {
        toast.error(result.error, { duration: 8_000 });
      }
    } finally {
      setPending(false);
      setConfirmDelete(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant={mode === 'create' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOpen(true)}
          disabled={!!lockedReason}
          className="gap-1.5"
          title={lockedReason}
        >
          {mode === 'create' ? <Plus className="size-3.5" /> : <Pencil className="size-3.5" />}
          {mode === 'create' ? 'New template' : 'Edit'}
        </Button>

        {mode === 'edit' && template ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              className="text-destructive gap-1.5"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>

            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{template.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This cannot be undone. A template attached to any campaign cannot be deleted —
                    detach it first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pending}
                    onClick={(event) => {
                      event.preventDefault();
                      void remove();
                    }}
                  >
                    {pending ? 'Deleting…' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}

        {lockedReason ? <span className="text-muted-foreground text-xs">{lockedReason}</span> : null}
      </div>
    );
  }

  return (
    <Card className="border-foreground/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          {mode === 'create' ? 'New template' : `Editing ${template?.name}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Name" htmlFor={`tname-${template?.id ?? 'new'}`} error={errors.name}>
          <Input
            id={`tname-${template?.id ?? 'new'}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Warm CRA intro"
            maxLength={120}
          />
        </Field>

        <Field label="Description" htmlFor={`tdesc-${template?.id ?? 'new'}`}>
          <Input
            id={`tdesc-${template?.id ?? 'new'}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="When to use this note"
            maxLength={500}
          />
        </Field>

        <Field
          label="Note body"
          htmlFor={`tbody-${template?.id ?? 'new'}`}
          error={errors.body}
          hint="Use {{firstName}}, {{lastName}}, {{company}} or {{jobTitle}}."
        >
          <Textarea
            id={`tbody-${template?.id ?? 'new'}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Hi {{firstName}}, I came across your profile and thought it would be worth connecting."
            maxLength={2000}
          />
        </Field>

        {/* --- Preview against a real lead ----------------------------- */}
        <div className="rounded-md border p-3">
          <div className="mb-2 flex items-center gap-2">
            <Eye className="size-3.5" />
            <span className="text-xs font-medium tracking-wide uppercase">Preview</span>
            {previewing ? <Loader2 className="size-3.5 animate-spin" /> : null}
          </div>

          {leadCount === 0 ? (
            <p className="text-muted-foreground text-sm">
              No leads in the database, so this cannot be previewed against real data. Import a CSV
              first — no example values are invented here.
            </p>
          ) : !preview ? (
            <p className="text-muted-foreground text-sm">Start typing to see the rendered note.</p>
          ) : preview.error ? (
            <Callout tone="warning" title="This note would not render">
              {preview.error}
              {preview.lead ? (
                <span className="mt-1 block text-xs">
                  Previewed against {preview.lead.fullName}.
                </span>
              ) : null}
            </Callout>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm whitespace-pre-wrap">{preview.rendered}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge variant={preview.length > preview.limit ? 'danger' : 'secondary'}>
                  {preview.length}/{preview.limit} characters
                </Badge>
                {preview.lead ? (
                  <Badge variant="muted">as {preview.lead.fullName}</Badge>
                ) : null}
                {preview.variablesUsed.map((variable) => (
                  <Badge key={variable} variant="secondary" className="font-mono">
                    {`{{${variable}}}`}
                  </Badge>
                ))}
              </div>

              {preview.wouldSkipCount > 0 ? (
                <p className="text-warning text-xs">
                  {formatNumber(preview.wouldSkipCount)} of{' '}
                  {formatNumber(preview.sampledLeads)} sampled lead(s) are missing a value this
                  note uses and would be skipped rather than contacted.
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Renders for all {formatNumber(preview.sampledLeads)} sampled lead(s).
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => void save()}
            disabled={pending || name.trim().length === 0 || body.trim().length === 0}
          >
            {pending ? 'Saving…' : mode === 'create' ? 'Create template' : 'Save changes'}
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
