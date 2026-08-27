import type {
  ErrorClass,
  IncidentSeverity,
  IncidentType,
  LeadStatus,
  PageState,
  QueueStatus,
} from '@prisma/client';

/**
 * Policy: what a detected page state *means*.
 *
 * Detection lives in the worker; the consequences live here, as pure data, so
 * the same rules are used by the worker, the API and the tests, and so the
 * safety-critical decisions can be reviewed in one place.
 *
 * The single most important property: no state that indicates a LinkedIn
 * security control is ever retryable, and every such state halts the worker.
 * There is no code path that attempts to work around one.
 */

export interface StatePolicy {
  /** Retry semantics. SAFETY is never retried. */
  errorClass: ErrorClass;
  /** Terminal status for the queue job. */
  queueStatus: QueueStatus;
  /** Status to write on the lead, or null to leave it unchanged. */
  leadStatus: LeadStatus | null;
  /** Incident to open, or null when this is a normal outcome. */
  incidentType: IncidentType | null;
  incidentSeverity: IncidentSeverity;
  /**
   * Latch the global kill switch. Reserved for evidence that LinkedIn has
   * flagged the account - continuing would make things worse.
   */
  engageKillSwitch: boolean;
  /** Stop the worker after this job, pending human review. */
  haltWorker: boolean;
  /** Value written to `queue_jobs.result` and `leads.lastResult`. */
  result: string;
  /** Operator-facing explanation. */
  description: string;
}

const POLICIES: Record<PageState, StatePolicy> = {
  // --- Normal outcomes ----------------------------------------------------
  AUTHENTICATED: {
    errorClass: 'NONE',
    queueStatus: 'COMPLETED',
    leadStatus: null,
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'AUTHENTICATED',
    description: 'Session is authenticated.',
  },
  PROFILE_FOUND: {
    errorClass: 'NONE',
    queueStatus: 'COMPLETED',
    leadStatus: null,
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'PROFILE_FOUND',
    description: 'Profile loaded.',
  },
  CONNECT_AVAILABLE: {
    errorClass: 'NONE',
    queueStatus: 'COMPLETED',
    leadStatus: null,
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'CONNECT_AVAILABLE',
    description: 'A connection request can be sent.',
  },
  ALREADY_CONNECTED: {
    errorClass: 'NONE',
    queueStatus: 'COMPLETED',
    leadStatus: 'ALREADY_CONNECTED',
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'ALREADY_CONNECTED',
    description: 'Already a first-degree connection. Nothing to send.',
  },
  INVITATION_PENDING: {
    errorClass: 'NONE',
    queueStatus: 'COMPLETED',
    leadStatus: 'ALREADY_PENDING',
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'ALREADY_PENDING',
    description: 'An invitation is already outstanding. Nothing to send.',
  },

  // --- Permanent, per-lead problems --------------------------------------
  PROFILE_NOT_FOUND: {
    errorClass: 'PERMANENT',
    queueStatus: 'FAILED',
    leadStatus: 'SKIPPED',
    incidentType: null,
    incidentSeverity: 'INFO',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'PROFILE_NOT_FOUND',
    description: 'Profile does not exist or is not reachable. Not retried.',
  },

  // --- Technical, retryable ----------------------------------------------
  NETWORK_ERROR: {
    errorClass: 'TECHNICAL',
    queueStatus: 'FAILED',
    leadStatus: null,
    incidentType: 'NETWORK_FAILURE',
    incidentSeverity: 'WARNING',
    engageKillSwitch: false,
    haltWorker: false,
    result: 'NETWORK_ERROR',
    description: 'Network or page-load failure. Retried with exponential backoff.',
  },

  // --- Safety states: never retried, always escalated --------------------
  LOGIN_REQUIRED: {
    errorClass: 'SAFETY',
    queueStatus: 'REQUIRES_REVIEW',
    leadStatus: null,
    incidentType: 'LOGIN_REQUIRED',
    incidentSeverity: 'CRITICAL',
    engageKillSwitch: false,
    haltWorker: true,
    result: 'LOGIN_REQUIRED',
    description:
      'The browser session is not logged in. Sign in by hand in the worker browser window, then resume.',
  },
  CAPTCHA: {
    errorClass: 'SAFETY',
    queueStatus: 'REQUIRES_REVIEW',
    leadStatus: 'REQUIRES_REVIEW',
    incidentType: 'CAPTCHA',
    incidentSeverity: 'CRITICAL',
    engageKillSwitch: true,
    haltWorker: true,
    result: 'CAPTCHA',
    description:
      'A CAPTCHA was presented. Automation is stopped. Solve it yourself in the browser window, then resume; nothing here attempts to bypass it.',
  },
  SECURITY_CHALLENGE: {
    errorClass: 'SAFETY',
    queueStatus: 'REQUIRES_REVIEW',
    leadStatus: 'REQUIRES_REVIEW',
    incidentType: 'SECURITY_CHALLENGE',
    incidentSeverity: 'CRITICAL',
    engageKillSwitch: true,
    haltWorker: true,
    result: 'SECURITY_CHALLENGE',
    description:
      'LinkedIn presented a security or identity verification step. Automation is stopped pending human action.',
  },
  ACCOUNT_RESTRICTED: {
    errorClass: 'SAFETY',
    queueStatus: 'REQUIRES_REVIEW',
    leadStatus: 'BLOCKED',
    incidentType: 'ACCOUNT_RESTRICTED',
    incidentSeverity: 'CRITICAL',
    engageKillSwitch: true,
    haltWorker: true,
    result: 'ACCOUNT_RESTRICTED',
    description:
      'The account appears restricted. All automation is stopped and will not restart until the restriction is resolved and the stop is cleared by hand.',
  },
  UNKNOWN_PAGE: {
    errorClass: 'SAFETY',
    queueStatus: 'REQUIRES_REVIEW',
    leadStatus: 'REQUIRES_REVIEW',
    incidentType: 'UNEXPECTED_PAGE',
    incidentSeverity: 'CRITICAL',
    engageKillSwitch: true,
    haltWorker: true,
    result: 'UNKNOWN_PAGE',
    description:
      'The page did not match any known state. Treated as unsafe: the worker stops rather than guessing what to click.',
  },
};

export function policyFor(state: PageState): StatePolicy {
  return POLICIES[state];
}

/** States that indicate a LinkedIn security control. Never retried, never bypassed. */
export const SAFETY_STATES: readonly PageState[] = [
  'CAPTCHA',
  'SECURITY_CHALLENGE',
  'ACCOUNT_RESTRICTED',
  'LOGIN_REQUIRED',
  'UNKNOWN_PAGE',
];

export function isSafetyState(state: PageState): boolean {
  return policyFor(state).errorClass === 'SAFETY';
}

export function isRetryable(errorClass: ErrorClass): boolean {
  return errorClass === 'TECHNICAL';
}

/**
 * Terminal states the worker may reach after successfully performing a CONNECT.
 * `SENT` is not a `PageState` - it is the verified outcome of the action, so it
 * carries its own policy entry.
 */
export const SENT_RESULT = 'SENT';

export interface SentPolicy extends StatePolicy {
  result: typeof SENT_RESULT;
}

/**
 * A profile that loaded fine but offered no action we could take - no Connect
 * affordance, an email-gated invitation, a note field that never appeared.
 *
 * Requirement 8, step 10: a profile that cannot be processed is marked
 * REQUIRES_REVIEW. It is a per-lead problem, not a platform one, so it does not
 * halt the worker or latch the kill switch - but it does need a person to look,
 * so it is not quietly filed as a plain failure either.
 */
export const UNPROCESSABLE_POLICY: StatePolicy = {
  errorClass: 'PERMANENT',
  queueStatus: 'REQUIRES_REVIEW',
  leadStatus: 'REQUIRES_REVIEW',
  incidentType: 'PROFILE_UNPROCESSABLE',
  incidentSeverity: 'WARNING',
  engageKillSwitch: false,
  haltWorker: false,
  result: 'PROFILE_UNPROCESSABLE',
  description:
    'Profile loaded but offered no action that could be taken. Escalated for review rather than guessed at.',
};

export const SENT_POLICY: SentPolicy = {
  errorClass: 'NONE',
  queueStatus: 'COMPLETED',
  leadStatus: 'SENT',
  incidentType: null,
  incidentSeverity: 'INFO',
  engageKillSwitch: false,
  haltWorker: false,
  result: SENT_RESULT,
  description: 'Invitation sent and confirmed by re-reading the page.',
};
