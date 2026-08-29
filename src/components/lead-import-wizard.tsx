'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Callout, EmptyState } from '@/components/ui/misc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber, humanizeEnum } from '@/lib/utils';
import {
  confirmLeadImport,
  previewLeadImport,
  type ImportPreviewPayload,
} from '@/server/actions/leads';

/**
 * Two-phase CSV import.
 *
 * Phase 1 analyses the file and shows exactly what would happen. Phase 2 writes,
 * and sends back the row count the operator was shown so the server can refuse
 * if it has changed in the meantime.
 *
 * The file is read in the browser and the text posted to a server action; it is
 * re-analysed server-side, so nothing here is trusted.
 */

const MAX_BYTES = 12 * 1024 * 1024;
const NONE = '__none__';

export function LeadImportWizard({
  campaigns,
}: {
  campaigns: { id: string; name: string; status: string }[];
}) {
  const router = useRouter();

  const [csv, setCsv] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportPreviewPayload | null>(null);
  const [campaignId, setCampaignId] = React.useState<string>(NONE);
  const [analysing, setAnalysing] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ created: number } | null>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    setPreview(null);
    setDone(null);

    if (!file) {
      setCsv(null);
      setFileName(null);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 12 MB.`);
      return;
    }

    const text = await file.text();
    setCsv(text);
    setFileName(file.name);

    setAnalysing(true);
    try {
      const result = await previewLeadImport({ csv: text, fileName: file.name });
      if (result.ok) setPreview(result.data);
      else setError(result.error);
    } catch {
      setError('Could not analyse that file.');
    } finally {
      setAnalysing(false);
    }
  }

  async function onConfirm() {
    if (!csv || !preview) return;
    setImporting(true);
    setError(null);

    try {
      const result = await confirmLeadImport({
        csv,
        fileName: fileName ?? undefined,
        campaignId: campaignId === NONE ? null : campaignId,
        expectedCount: preview.summary.willImport,
      });

      if (result.ok) {
        setDone({ created: result.data.created });
        toast.success(result.message ?? `Imported ${result.data.created} lead(s).`);
        router.refresh();
      } else {
        setError(result.error);
        toast.error(result.error);
      }
    } catch {
      setError('The import failed. Nothing was written.');
    } finally {
      setImporting(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState
            icon={<CheckCircle2 className="text-success size-8" />}
            title={`Imported ${formatNumber(done.created)} lead(s)`}
            description="They start as PENDING. Nothing is contacted until you create a campaign and activate it."
            action={
              <div className="flex gap-2">
                <Button onClick={() => router.push('/leads')}>View leads</Button>
                <Button variant="outline" onClick={() => router.push('/campaigns/new')}>
                  Create campaign
                </Button>
              </div>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const summary = preview?.summary;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">1. Choose a file</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="CSV file" htmlFor="csv-file">
            <Input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} />
          </Field>

          {analysing ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Analysing {fileName}…
            </p>
          ) : null}

          {error ? <Callout tone="danger" title="Problem">{error}</Callout> : null}
        </CardContent>
      </Card>

      {preview && summary ? (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">2. Review</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Rows in file" value={summary.totalRows} />
                <Stat label="Will import" value={summary.willImport} tone="success" />
                <Stat label="Duplicate in file" value={summary.duplicateInFile} tone="muted" />
                <Stat label="Already in database" value={summary.alreadyInDatabase} tone="info" />
                <Stat label="Invalid" value={summary.invalid} tone="danger" />
              </div>

              {preview.parseErrors.length > 0 ? (
                <Callout tone="warning" title="Parser warnings">
                  <ul className="list-disc pl-5">
                    {preview.parseErrors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </Callout>
              ) : null}

              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="text-muted-foreground">Detected columns:</span>
                {Object.entries(preview.detectedColumns).map(([field, header]) => (
                  <Badge key={field} variant="secondary">
                    {field} ← {header}
                  </Badge>
                ))}
              </div>

              {preview.unmatchedHeaders.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Ignored columns: {preview.unmatchedHeaders.join(', ')}
                </p>
              ) : null}

              {/* Anything guessed about the file's shape is stated here rather
                  than applied quietly. */}
              {preview.detection.skippedLeadingRows > 0 ||
              preview.detection.headerless ||
              preview.detection.urlColumnFoundByContent ||
              preview.detection.fuzzyMatchedColumns.length > 0 ? (
                <Callout tone="warning" title="How this file was read">
                  <ul className="list-disc pl-5">
                    {preview.detection.skippedLeadingRows > 0 ? (
                      <li>
                        Skipped {preview.detection.skippedLeadingRows} row
                        {preview.detection.skippedLeadingRows === 1 ? '' : 's'} above the header;
                        row {preview.detection.headerRow} was used as the header.
                      </li>
                    ) : null}
                    {preview.detection.headerless ? (
                      <li>
                        No header row found, so every row was treated as data and columns were
                        named <code>column_1</code>, <code>column_2</code>, and so on.
                      </li>
                    ) : null}
                    {preview.detection.urlColumnFoundByContent ? (
                      <li>
                        No column was named like a profile URL, so &ldquo;
                        {preview.detection.urlColumnFoundByContent}&rdquo; was used because its
                        values are LinkedIn profile URLs.
                      </li>
                    ) : null}
                    {preview.detection.fuzzyMatchedColumns.length > 0 ? (
                      <li>
                        Matched on partial column names:{' '}
                        {preview.detection.fuzzyMatchedColumns.join(', ')}.
                      </li>
                    ) : null}
                  </ul>
                  Check the sample below before importing.
                </Callout>
              ) : null}

              {summary.willImport === 0 ? (
                <Callout tone="warning" title="Nothing to import">
                  Every row is either invalid, a duplicate within the file, or already in the
                  database.
                </Callout>
              ) : null}
            </CardContent>
          </Card>

          {preview.sample.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">
                  Preview — first {preview.sample.length} of {formatNumber(summary.willImport)} to
                  import
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Normalised profile URL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.sample.map((row) => (
                      <TableRow key={row.rowNumber}>
                        <TableCell className="tabular text-muted-foreground">
                          {row.rowNumber}
                        </TableCell>
                        <TableCell className="font-medium">
                          {row.fullName}
                          {row.nameDerivedFromUrl ? (
                            <Badge variant="muted" className="ml-2">
                              from URL
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{row.company ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{row.jobTitle ?? '—'}</TableCell>
                        <TableCell className="font-mono text-xs">{row.linkedinUrl}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {preview.alreadyInDatabase.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  Already in the database — will be skipped
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Existing status</TableHead>
                      <TableHead>Campaign</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.alreadyInDatabase.map((row) => (
                      <TableRow key={row.linkedinUrl}>
                        <TableCell>{row.fullName}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{humanizeEnum(row.existingStatus)}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.existingCampaign ?? 'Unassigned'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {preview.rejected.length > 0 || preview.duplicatesInFile.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="size-4" /> Rejected rows
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...preview.rejected, ...preview.duplicatesInFile]
                      .sort((a, b) => a.rowNumber - b.rowNumber)
                      .map((row) => (
                        <TableRow key={`${row.rowNumber}-${row.message}`}>
                          <TableCell className="tabular">{row.rowNumber}</TableCell>
                          <TableCell>{row.message}</TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {row.rawUrl || '(empty)'}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">3. Confirm</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Field
                label="Assign to campaign (optional)"
                hint="You can assign leads later. Only draft, ready and paused campaigns are listed - leads cannot be dropped into a running campaign."
              >
                <Select value={campaignId} onValueChange={setCampaignId}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue placeholder="Leave unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Leave unassigned</SelectItem>
                    {campaigns.map((campaign) => (
                      <SelectItem key={campaign.id} value={campaign.id}>
                        {campaign.name} ({humanizeEnum(campaign.status)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void onConfirm()}
                  disabled={importing || summary.willImport === 0}
                  className="gap-1.5"
                >
                  {importing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FileUp className="size-4" />
                  )}
                  {importing
                    ? 'Importing…'
                    : `Import ${formatNumber(summary.willImport)} lead(s)`}
                </Button>
                <p className="text-muted-foreground text-xs">
                  Leads are created as PENDING. No outreach happens until a campaign is activated.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'danger' | 'muted' | 'info';
}) {
  const colour = {
    default: '',
    success: 'text-success',
    danger: 'text-destructive',
    muted: 'text-muted-foreground',
    info: 'text-info',
  }[tone];

  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      <div className={`tabular text-xl font-semibold ${colour}`}>{formatNumber(value)}</div>
    </div>
  );
}
