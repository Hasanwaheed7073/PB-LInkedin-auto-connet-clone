import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { chromium, type Browser, type Page } from 'playwright';

import { AbortError, performConnect } from '@/worker/actions/connect';
import { createLogger } from '@/worker/logger';

import { startMockLinkedIn, type MockLinkedInHandle } from '../mock-linkedin/server';

/**
 * The CONNECT action, driven through a real browser against local fixtures.
 *
 * The property under test throughout: **the outcome comes from re-reading the
 * page, never from the click succeeding**. Every case here is one where a naive
 * implementation would report success.
 */

let mock: MockLinkedInHandle;
let browser: Browser;
let page: Page;

const logger = createLogger({ test: 'connect' }, 'error');

beforeAll(async () => {
  mock = await startMockLinkedIn();
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await mock?.close();
});

beforeEach(async () => {
  page = await browser.newPage();
});

afterEach(async () => {
  await page?.close().catch(() => undefined);
});

function params(slug: string, overrides: Partial<Parameters<typeof performConnect>[0]> = {}) {
  return {
    page,
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    logger,
    navTimeoutMs: 20_000,
    note: null as string | null,
    signal: new AbortController().signal,
    mockBaseUrl: mock.url,
    ...overrides,
  };
}

describe('sending succeeds only when the page confirms it', () => {
  it('sends an invitation and verifies the resulting Pending state', async () => {
    const outcome = await performConnect(params('connect-flow'));

    expect(outcome.kind).toBe('SENT');
    if (outcome.kind !== 'SENT') return;
    expect(outcome.verifiedBy).toBeTruthy();
    expect(outcome.noteSent).toBe(false);
  });

  it('types the connection note it was given', async () => {
    const note = 'Hi Jane, I came across your profile and thought it would be worth connecting.';
    const outcome = await performConnect(params('connect-flow', { note }));

    expect(outcome.kind).toBe('SENT');
    if (outcome.kind !== 'SENT') return;
    expect(outcome.noteSent).toBe(true);

    // The fixture records what was actually typed into the note field.
    const typed = await page.evaluate(() => (window as unknown as { __sentNote?: string }).__sentNote);
    expect(typed).toBe(note);
  });

  it('records that the invitation was actually submitted, not just clicked', async () => {
    await performConnect(params('connect-flow'));
    const submitted = await page.evaluate(
      () => (window as unknown as { __invitationSent?: boolean }).__invitationSent,
    );
    expect(submitted).toBe(true);
  });
});

describe('nothing is sent when there is nothing to send', () => {
  it('reports ALREADY_CONNECTED without clicking anything', async () => {
    const outcome = await performConnect(params('already-connected'));

    expect(outcome.kind).toBe('STATE');
    if (outcome.kind !== 'STATE') return;
    expect(outcome.state).toBe('ALREADY_CONNECTED');
  });

  it('reports ALREADY_PENDING without sending a second invitation', async () => {
    const outcome = await performConnect(params('invitation-pending'));

    expect(outcome.kind).toBe('STATE');
    if (outcome.kind !== 'STATE') return;
    expect(outcome.state).toBe('INVITATION_PENDING');
  });

  it('reports a missing profile', async () => {
    const outcome = await performConnect(params('not-found'));

    expect(outcome.kind).toBe('STATE');
    if (outcome.kind !== 'STATE') return;
    expect(outcome.state).toBe('PROFILE_NOT_FOUND');
  });

  it('escalates a profile with no connect affordance instead of guessing', async () => {
    const outcome = await performConnect(params('no-affordance'));

    expect(outcome.kind).toBe('UNPROCESSABLE');
    if (outcome.kind !== 'UNPROCESSABLE') return;
    // The fixture carries a "People also viewed" sidebar with Connect buttons
    // for other people. Refusing here - while those remain unclicked - is the
    // whole point: the owner has no Connect, so there is nothing to do.
    expect(outcome.reason).toMatch(/no connect action/i);
    expect(outcome.state).toBe('PROFILE_FOUND');
  });

  it('never clicks a Connect button belonging to someone else on the page', async () => {
    // Regression guard for a bug that reached production: the sidebar's
    // stranger Connect is a <button> while the owner's own control is not, so
    // "click the first Connect button" invited the wrong person.
    const outcome = await performConnect(params('no-affordance'));

    expect(outcome.kind).toBe('UNPROCESSABLE');
    if (outcome.kind !== 'UNPROCESSABLE') return;
    expect(outcome.reason).not.toContain('Hamza');
    expect(outcome.reason).not.toContain('Puneet');
  });
});

describe('security states stop the action immediately', () => {
  it('stops on a CAPTCHA and does not click', async () => {
    const outcome = await performConnect(params('security-wall-dom'));

    expect(outcome.kind).toBe('SAFETY');
    if (outcome.kind !== 'SAFETY') return;
    expect(outcome.state).toBe('CAPTCHA');
  });

  it('stops on a security challenge', async () => {
    const outcome = await performConnect(params('verify-step-dom'));

    expect(outcome.kind).toBe('SAFETY');
    if (outcome.kind !== 'SAFETY') return;
    expect(outcome.state).toBe('SECURITY_CHALLENGE');
  });

  it('stops on an account restriction', async () => {
    const outcome = await performConnect(params('flagged-account-dom'));

    expect(outcome.kind).toBe('SAFETY');
    if (outcome.kind !== 'SAFETY') return;
    expect(outcome.state).toBe('ACCOUNT_RESTRICTED');
  });

  it('stops when the session turns out to be signed out', async () => {
    const outcome = await performConnect(params('needs-login'));

    expect(outcome.kind).toBe('SAFETY');
    if (outcome.kind !== 'SAFETY') return;
    expect(outcome.state).toBe('LOGIN_REQUIRED');
  });

  it('stops on an unrecognised page rather than clicking blindly', async () => {
    const outcome = await performConnect(params('weird-page'));

    expect(outcome.kind).toBe('SAFETY');
    if (outcome.kind !== 'SAFETY') return;
    expect(outcome.state).toBe('UNKNOWN_PAGE');
  });

  it('a visible CAPTCHA over a connectable profile still stops the action', async () => {
    const outcome = await performConnect(params('visible-challenge-overlay'));
    expect(outcome.kind).toBe('SAFETY');
  });
});

describe('awkward invitation dialogs are escalated, never forced', () => {
  it('skips a profile that demands an email address', async () => {
    const outcome = await performConnect(params('connect-email-gate'));

    expect(outcome.kind).toBe('UNPROCESSABLE');
    if (outcome.kind !== 'UNPROCESSABLE') return;
    expect(outcome.reason).toContain('email');
  });

  it('refuses to send a bare invitation when a note was configured but no field exists', async () => {
    const outcome = await performConnect(
      params('connect-no-note', { note: 'Hi Jane, worth connecting.' }),
    );

    expect(outcome.kind).toBe('UNPROCESSABLE');
    if (outcome.kind !== 'UNPROCESSABLE') return;
    expect(outcome.reason).toContain('no note field');
  });

  it('DOES send when no note was configured and the dialog offers none', async () => {
    const outcome = await performConnect(params('connect-no-note', { note: null }));
    expect(outcome.kind).toBe('SENT');
  });
});

describe('technical failures are reported as technical', () => {
  it('reports a navigation failure rather than a safety state', async () => {
    const outcome = await performConnect(
      params('connect-flow', { mockBaseUrl: 'http://127.0.0.1:1', navTimeoutMs: 3_000 }),
    );

    expect(outcome.kind).toBe('TECHNICAL_FAILURE');
    if (outcome.kind !== 'TECHNICAL_FAILURE') return;
    expect(outcome.message).toContain('Navigation');
  });
});

describe('the emergency stop interrupts an action in flight', () => {
  it('throws AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(performConnect(params('connect-flow', { signal: controller.signal }))).rejects.toThrow(
      AbortError,
    );
  });

  it('does not send after being aborted before the click', async () => {
    const controller = new AbortController();
    controller.abort();

    await performConnect(params('connect-flow', { signal: controller.signal })).catch(() => undefined);

    // Nothing was submitted, because the abort happened before navigation.
    const submitted = await page.evaluate(
      () => (window as unknown as { __invitationSent?: boolean }).__invitationSent,
    );
    expect(submitted).toBeUndefined();
  });
});
