import Link from 'next/link';

import { Camera, Cpu, ExternalLink, Target, User } from 'lucide-react';

import { IncidentResolveControls } from '@/components/incident-resolve-controls';
import {
  IncidentSeverityBadge,
  IncidentStatusBadge,
  LeadStatusBadge,
  PageStateBadge,
} from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp, humanizeEnum } from '@/lib/utils';

/**
 * One incident, with everything an operator needs to decide.
 *
 * The screenshot is shown as a path, not an image: the file lives outside the
 * Next public directory on purpose, so browser session evidence is not served
 * over HTTP. Requirement 21 - no session data exposed to the frontend.
 */

export interface IncidentCardData {
  id: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string;
  description: string;
  blocksWorker: boolean;
  pageState: string | null;
  pageUrl: string | null;
  screenshotPath: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolutionAction: string | null;
  lead: { id: string; fullName: string; linkedinUrl: string; status: string } | null;
  campaign: { id: string; name: string } | null;
  worker: { id: string; name: string } | null;
  queueJob: { id: string; status: string; attempts: number; maxAttempts: number } | null;
}

export function IncidentCard({ incident }: { incident: IncidentCardData }) {
  const resolved = incident.status === 'RESOLVED';

  return (
    <Card className={incident.blocksWorker && !resolved ? 'border-destructive/40' : undefined}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{incident.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <IncidentSeverityBadge severity={incident.severity} />
            <IncidentStatusBadge status={incident.status} />
            {incident.blocksWorker && !resolved ? (
              <Badge variant="danger">Holding automation</Badge>
            ) : null}
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {humanizeEnum(incident.type)} · {formatTimestamp(incident.createdAt)}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed">{incident.description}</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {incident.lead ? (
            <span className="flex items-center gap-1.5">
              <User className="size-3.5" />
              <Link
                href={`/leads?q=${encodeURIComponent(incident.lead.fullName)}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {incident.lead.fullName}
              </Link>
              <LeadStatusBadge status={incident.lead.status as never} />
              <a
                href={incident.lead.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
              >
                profile <ExternalLink className="size-3" />
              </a>
            </span>
          ) : null}

          {incident.campaign ? (
            <span className="flex items-center gap-1.5">
              <Target className="size-3.5" />
              <Link
                href={`/campaigns/${incident.campaign.id}`}
                className="underline-offset-2 hover:underline"
              >
                {incident.campaign.name}
              </Link>
            </span>
          ) : null}

          {incident.worker ? (
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Cpu className="size-3.5" />
              {incident.worker.name}
            </span>
          ) : null}

          {incident.pageState ? <PageStateBadge state={incident.pageState as never} /> : null}

          {incident.queueJob ? (
            <span className="text-muted-foreground">
              Job {incident.queueJob.status.toLowerCase()} · attempt {incident.queueJob.attempts}/
              {incident.queueJob.maxAttempts}
            </span>
          ) : null}
        </div>

        {incident.screenshotPath ? (
          <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <Camera className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Screenshot saved to{' '}
              <code className="font-mono break-all">{incident.screenshotPath}</code>
              <span className="block">
                Open it from disk. Screenshots are deliberately not served over HTTP, because they
                can contain the signed-in session.
              </span>
            </span>
          </div>
        ) : null}

        {incident.pageUrl ? (
          <p className="text-muted-foreground text-xs">
            Page: <code className="font-mono break-all">{incident.pageUrl}</code>
          </p>
        ) : null}

        {resolved ? (
          <div className="bg-muted/40 rounded-md p-3 text-xs">
            <p className="font-medium">
              Resolved{incident.resolvedBy ? ` by ${incident.resolvedBy}` : ''}
              {incident.resolvedAt ? ` at ${formatTimestamp(incident.resolvedAt)}` : ''}
              {incident.resolutionAction ? ` — ${humanizeEnum(incident.resolutionAction)}` : ''}
            </p>
            {incident.resolutionNote ? (
              <p className="text-muted-foreground mt-1">{incident.resolutionNote}</p>
            ) : null}
          </div>
        ) : (
          <IncidentResolveControls
            incidentId={incident.id}
            // Narrowed by the `resolved` branch above: only OPEN and
            // ACKNOWLEDGED reach here.
            status={incident.status as 'OPEN' | 'ACKNOWLEDGED'}
            hasLead={!!incident.lead}
            hasCampaign={!!incident.campaign}
            leadName={incident.lead?.fullName ?? null}
            blocksWorker={incident.blocksWorker}
          />
        )}
      </CardContent>
    </Card>
  );
}
