import type {
  CampaignStatus,
  IncidentSeverity,
  IncidentStatus,
  LeadStatus,
  PageState,
  QueueStatus,
  SessionStatus,
  WorkerStatus,
} from '@prisma/client';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/misc';
import { humanizeEnum } from '@/lib/utils';

/**
 * Enum -> badge mapping, in one place.
 *
 * The colour is meaningful and consistent everywhere: green means done and
 * fine, amber means needs attention, red means stopped or blocked, grey means
 * inert. Anything requiring human action is never green.
 */

type Variant = NonNullable<BadgeProps['variant']>;

const LEAD_STATUS_VARIANT: Record<LeadStatus, Variant> = {
  PENDING: 'muted',
  PROCESSING: 'info',
  SENT: 'success',
  ALREADY_CONNECTED: 'secondary',
  ALREADY_PENDING: 'secondary',
  SKIPPED: 'muted',
  FAILED: 'danger',
  REQUIRES_REVIEW: 'warning',
  BLOCKED: 'danger',
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <Badge variant={LEAD_STATUS_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

const CAMPAIGN_STATUS_VARIANT: Record<CampaignStatus, Variant> = {
  DRAFT: 'muted',
  READY: 'info',
  RUNNING: 'success',
  PAUSED: 'warning',
  COMPLETED: 'secondary',
  ERROR: 'danger',
};

export function CampaignStatusBadge({
  status,
  active,
}: {
  status: CampaignStatus;
  active?: boolean;
}) {
  return (
    <Badge variant={CAMPAIGN_STATUS_VARIANT[status]} className="gap-1.5">
      {status === 'RUNNING' && active ? <StatusDot tone="success" pulse /> : null}
      {humanizeEnum(status)}
    </Badge>
  );
}

const QUEUE_STATUS_VARIANT: Record<QueueStatus, Variant> = {
  WAITING: 'muted',
  PROCESSING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'secondary',
  REQUIRES_REVIEW: 'warning',
};

export function QueueStatusBadge({ status }: { status: QueueStatus }) {
  return <Badge variant={QUEUE_STATUS_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

const WORKER_STATUS_VARIANT: Record<WorkerStatus, Variant> = {
  STARTING: 'info',
  IDLE: 'secondary',
  RUNNING: 'success',
  PAUSED: 'warning',
  DRAINING: 'warning',
  STOPPED: 'muted',
  UNHEALTHY: 'danger',
};

export function WorkerStatusBadge({
  status,
  healthy,
}: {
  status: WorkerStatus;
  healthy?: boolean;
}) {
  // A stale heartbeat overrides whatever the worker last claimed to be doing -
  // showing RUNNING for a process that stopped reporting would be misleading.
  const effective: WorkerStatus = healthy === false && status !== 'STOPPED' ? 'UNHEALTHY' : status;
  return (
    <Badge variant={WORKER_STATUS_VARIANT[effective]} className="gap-1.5">
      {effective === 'RUNNING' ? <StatusDot tone="success" pulse /> : null}
      {humanizeEnum(effective)}
    </Badge>
  );
}

const SESSION_STATUS_VARIANT: Record<SessionStatus, Variant> = {
  UNKNOWN: 'muted',
  CONNECTED: 'success',
  DISCONNECTED: 'danger',
  LOGIN_REQUIRED: 'warning',
  CHALLENGE_DETECTED: 'danger',
};

const SESSION_LABEL: Record<SessionStatus, string> = {
  UNKNOWN: 'Unknown',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  LOGIN_REQUIRED: 'Login required',
  CHALLENGE_DETECTED: 'Challenge detected',
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return <Badge variant={SESSION_STATUS_VARIANT[status]}>{SESSION_LABEL[status]}</Badge>;
}

const INCIDENT_SEVERITY_VARIANT: Record<IncidentSeverity, Variant> = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'danger',
};

export function IncidentSeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <Badge variant={INCIDENT_SEVERITY_VARIANT[severity]}>{humanizeEnum(severity)}</Badge>;
}

const INCIDENT_STATUS_VARIANT: Record<IncidentStatus, Variant> = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warning',
  RESOLVED: 'success',
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <Badge variant={INCIDENT_STATUS_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

const PAGE_STATE_VARIANT: Record<PageState, Variant> = {
  AUTHENTICATED: 'success',
  PROFILE_FOUND: 'secondary',
  CONNECT_AVAILABLE: 'info',
  ALREADY_CONNECTED: 'secondary',
  INVITATION_PENDING: 'secondary',
  PROFILE_NOT_FOUND: 'muted',
  NETWORK_ERROR: 'warning',
  LOGIN_REQUIRED: 'danger',
  CAPTCHA: 'danger',
  SECURITY_CHALLENGE: 'danger',
  ACCOUNT_RESTRICTED: 'danger',
  UNKNOWN_PAGE: 'danger',
};

export function PageStateBadge({ state }: { state: PageState }) {
  return <Badge variant={PAGE_STATE_VARIANT[state]}>{humanizeEnum(state)}</Badge>;
}

/** Activity-log outcome. */
export function ActivityResultBadge({ result }: { result: string }) {
  const variant: Variant =
    result === 'SUCCESS'
      ? 'success'
      : result === 'FAILED'
        ? 'danger'
        : result === 'REQUIRES_REVIEW'
          ? 'warning'
          : result === 'CANCELLED' || result === 'SKIPPED'
            ? 'muted'
            : 'secondary';
  return <Badge variant={variant}>{humanizeEnum(result)}</Badge>;
}
