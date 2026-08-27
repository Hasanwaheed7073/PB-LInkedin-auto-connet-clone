import type { PageState } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  SAFETY_STATES,
  SENT_POLICY,
  isRetryable,
  isSafetyState,
  policyFor,
} from '@/lib/page-state-policy';

/**
 * Safety policy invariants.
 *
 * These are the assertions that keep the system from doing the one thing it must
 * never do: retry, work around, or quietly ignore a LinkedIn security control.
 * Written as properties over the whole enum rather than case-by-case, so adding
 * a new PageState without deciding its policy fails the build.
 */

const ALL_STATES: PageState[] = [
  'AUTHENTICATED',
  'LOGIN_REQUIRED',
  'PROFILE_FOUND',
  'PROFILE_NOT_FOUND',
  'ALREADY_CONNECTED',
  'INVITATION_PENDING',
  'CONNECT_AVAILABLE',
  'SECURITY_CHALLENGE',
  'CAPTCHA',
  'ACCOUNT_RESTRICTED',
  'UNKNOWN_PAGE',
  'NETWORK_ERROR',
];

const SECURITY_CONTROL_STATES: PageState[] = [
  'CAPTCHA',
  'SECURITY_CHALLENGE',
  'ACCOUNT_RESTRICTED',
];

describe('every page state has a policy', () => {
  it.each(ALL_STATES)('%s has a complete policy', (state) => {
    const policy = policyFor(state);
    expect(policy).toBeDefined();
    expect(policy.result).toBeTruthy();
    expect(policy.description.length).toBeGreaterThan(10);
    expect(['NONE', 'TECHNICAL', 'PERMANENT', 'SAFETY']).toContain(policy.errorClass);
  });
});

describe('safety states are never retried', () => {
  it.each(SAFETY_STATES)('%s is classified SAFETY', (state) => {
    expect(policyFor(state).errorClass).toBe('SAFETY');
  });

  it('SAFETY is not retryable', () => {
    expect(isRetryable('SAFETY')).toBe(false);
  });

  it('only TECHNICAL is retryable', () => {
    expect(isRetryable('TECHNICAL')).toBe(true);
    expect(isRetryable('PERMANENT')).toBe(false);
    expect(isRetryable('NONE')).toBe(false);
  });

  it.each(SAFETY_STATES)('%s halts the worker', (state) => {
    expect(policyFor(state).haltWorker).toBe(true);
  });

  it.each(SAFETY_STATES)('%s sends the job to REQUIRES_REVIEW', (state) => {
    expect(policyFor(state).queueStatus).toBe('REQUIRES_REVIEW');
  });

  it.each(SAFETY_STATES)('%s opens an incident', (state) => {
    expect(policyFor(state).incidentType).not.toBeNull();
  });

  it.each(SAFETY_STATES)('%s is marked CRITICAL', (state) => {
    expect(policyFor(state).incidentSeverity).toBe('CRITICAL');
  });
});

describe('evidence of a LinkedIn security control latches the kill switch', () => {
  it.each(SECURITY_CONTROL_STATES)('%s engages the kill switch', (state) => {
    expect(policyFor(state).engageKillSwitch).toBe(true);
  });

  it('an unrecognised page also stops everything rather than guessing', () => {
    expect(policyFor('UNKNOWN_PAGE').engageKillSwitch).toBe(true);
    expect(policyFor('UNKNOWN_PAGE').errorClass).toBe('SAFETY');
  });

  it('a plain login prompt does NOT latch the kill switch', () => {
    // Being signed out is a session problem, not evidence the account is
    // flagged. It still halts the worker and opens a blocking incident.
    const policy = policyFor('LOGIN_REQUIRED');
    expect(policy.engageKillSwitch).toBe(false);
    expect(policy.haltWorker).toBe(true);
  });

  it('no normal outcome ever latches the kill switch', () => {
    for (const state of ALL_STATES) {
      if (isSafetyState(state)) continue;
      expect(policyFor(state).engageKillSwitch).toBe(false);
      expect(policyFor(state).haltWorker).toBe(false);
    }
  });
});

describe('normal outcomes', () => {
  it('an existing connection completes without sending anything', () => {
    const policy = policyFor('ALREADY_CONNECTED');
    expect(policy.queueStatus).toBe('COMPLETED');
    expect(policy.leadStatus).toBe('ALREADY_CONNECTED');
    expect(policy.errorClass).toBe('NONE');
    expect(policy.result).not.toBe('SENT');
  });

  it('an outstanding invitation completes without sending anything', () => {
    const policy = policyFor('INVITATION_PENDING');
    expect(policy.queueStatus).toBe('COMPLETED');
    expect(policy.leadStatus).toBe('ALREADY_PENDING');
    expect(policy.result).not.toBe('SENT');
  });

  it('a missing profile is permanent and not retried', () => {
    const policy = policyFor('PROFILE_NOT_FOUND');
    expect(policy.errorClass).toBe('PERMANENT');
    expect(isRetryable(policy.errorClass)).toBe(false);
    expect(policy.leadStatus).toBe('SKIPPED');
    expect(policy.incidentType).toBeNull();
  });

  it('a network error is technical and retried, and opens no blocking incident', () => {
    const policy = policyFor('NETWORK_ERROR');
    expect(policy.errorClass).toBe('TECHNICAL');
    expect(isRetryable(policy.errorClass)).toBe(true);
    expect(policy.haltWorker).toBe(false);
    expect(policy.engageKillSwitch).toBe(false);
  });
});

describe('SENT is the only policy that records an invitation', () => {
  it('marks the lead SENT and completes the job', () => {
    expect(SENT_POLICY.result).toBe('SENT');
    expect(SENT_POLICY.leadStatus).toBe('SENT');
    expect(SENT_POLICY.queueStatus).toBe('COMPLETED');
    expect(SENT_POLICY.errorClass).toBe('NONE');
  });

  it('no PageState policy can produce a SENT result', () => {
    // SENT is only reachable through verification in the CONNECT action, never
    // by classifying a page. This is what stops a detector change from silently
    // marking leads as contacted.
    for (const state of ALL_STATES) {
      expect(policyFor(state).result).not.toBe('SENT');
    }
    for (const state of ALL_STATES) {
      expect(policyFor(state).leadStatus).not.toBe('SENT');
    }
  });
});

describe('isSafetyState', () => {
  it('agrees with the exported list', () => {
    for (const state of ALL_STATES) {
      expect(isSafetyState(state)).toBe(SAFETY_STATES.includes(state));
    }
  });
});

describe('UNPROCESSABLE_POLICY - a profile that loaded but offered no action', () => {
  it('sends the lead and the job to REQUIRES_REVIEW', async () => {
    const { UNPROCESSABLE_POLICY } = await import('@/lib/page-state-policy');
    expect(UNPROCESSABLE_POLICY.leadStatus).toBe('REQUIRES_REVIEW');
    expect(UNPROCESSABLE_POLICY.queueStatus).toBe('REQUIRES_REVIEW');
  });

  it('is permanent - it is never retried', async () => {
    const { UNPROCESSABLE_POLICY, isRetryable } = await import('@/lib/page-state-policy');
    expect(UNPROCESSABLE_POLICY.errorClass).toBe('PERMANENT');
    expect(isRetryable(UNPROCESSABLE_POLICY.errorClass)).toBe(false);
  });

  it('does not halt the worker or stop everything - it is one awkward profile', async () => {
    const { UNPROCESSABLE_POLICY } = await import('@/lib/page-state-policy');
    expect(UNPROCESSABLE_POLICY.haltWorker).toBe(false);
    expect(UNPROCESSABLE_POLICY.engageKillSwitch).toBe(false);
  });

  it('opens an incident so a person sees it', async () => {
    const { UNPROCESSABLE_POLICY } = await import('@/lib/page-state-policy');
    expect(UNPROCESSABLE_POLICY.incidentType).toBe('PROFILE_UNPROCESSABLE');
  });

  it('never records anything as sent', async () => {
    const { UNPROCESSABLE_POLICY } = await import('@/lib/page-state-policy');
    expect(UNPROCESSABLE_POLICY.result).not.toBe('SENT');
  });
});
