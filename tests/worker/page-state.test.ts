import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { chromium, type Browser, type Page } from 'playwright';

import { detectConnectionState, detectPageState, detectSessionState } from '@/worker/page-state';

import { startMockLinkedIn, type MockLinkedInHandle } from '../mock-linkedin/server';

/**
 * Page-state detection, against a real Chromium loading real HTTP responses.
 *
 * This is the test that matters most for safety. If detection misclassifies a
 * CAPTCHA as a profile, the worker keeps going into a security wall; if it
 * misclassifies "already connected" as "connect available", we send a duplicate.
 *
 * Nothing here touches linkedin.com - every page comes from the local fixture
 * server in tests/mock-linkedin.
 */

let mock: MockLinkedInHandle;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  mock = await startMockLinkedIn();
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await mock?.close();
});

/**
 * A fresh page per test. Necessary rather than tidy: one of these tests
 * navigates to a refused port, which can leave the renderer in a state where a
 * later `setContent` fails with "Page crashed". Isolating pages keeps a
 * deliberately hostile case from breaking unrelated tests.
 */
beforeEach(async () => {
  page = await browser.newPage();
});

afterEach(async () => {
  await page?.close().catch(() => undefined);
});

async function goto(path: string): Promise<void> {
  await page.goto(`${mock.url}${path}`, { waitUntil: 'domcontentloaded' });
}

describe('security states are detected and win over everything else', () => {
  it('detects a CAPTCHA from the DOM', async () => {
    await goto('/in/security-wall-dom');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('CAPTCHA');
  });

  it('detects a CAPTCHA from the URL pattern', async () => {
    await goto('/checkpoint/challenge/AgH1234');
    const result = await detectPageState(page);
    expect(result.state).toBe('CAPTCHA');
    expect(result.matchedBy).toContain('url:');
  });

  it('detects a security challenge', async () => {
    await goto('/in/verify-step-dom');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('SECURITY_CHALLENGE');
  });

  it('treats an unrecognised /checkpoint/ URL as a security challenge', async () => {
    await goto('/checkpoint/something-new-we-have-never-seen');
    const result = await detectPageState(page);
    expect(result.state).toBe('SECURITY_CHALLENGE');
  });

  it('detects an account restriction', async () => {
    await goto('/in/flagged-account-dom');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('ACCOUNT_RESTRICTED');
  });

  it('detects an account restriction from the URL', async () => {
    await goto('/checkpoint/restricted');
    const result = await detectPageState(page);
    expect(result.state).toBe('ACCOUNT_RESTRICTED');
  });

  it('detects a login wall', async () => {
    await goto('/login');
    const result = await detectPageState(page);
    expect(result.state).toBe('LOGIN_REQUIRED');
  });

  it('detects a login form served at a profile URL', async () => {
    await goto('/in/needs-login');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('LOGIN_REQUIRED');
  });
});

describe('profile connection states', () => {
  it('detects that a connection request can be sent', async () => {
    await goto('/in/connect-available');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('CONNECT_AVAILABLE');
  });

  it('detects an existing first-degree connection', async () => {
    await goto('/in/already-connected');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('ALREADY_CONNECTED');
  });

  it('detects an outstanding invitation', async () => {
    await goto('/in/invitation-pending');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('INVITATION_PENDING');
  });

  it('detects a missing profile', async () => {
    await goto('/in/not-found');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('PROFILE_NOT_FOUND');
  });

  it('does NOT report CONNECT_AVAILABLE when the profile has no connect affordance', async () => {
    await goto('/in/no-affordance');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('PROFILE_FOUND');
    expect(result.state).not.toBe('CONNECT_AVAILABLE');
  });

  it('prefers a pending invitation over any other signal', async () => {
    // The pending fixture also has a Message button; pending must still win, as
    // acting on it would mean a duplicate invitation.
    await goto('/in/invitation-pending');
    const connection = await detectConnectionState(page);
    expect(connection.state).toBe('INVITATION_PENDING');
  });

  it('does not read a lone Message button as already-connected', async () => {
    await goto('/in/no-affordance');
    const connection = await detectConnectionState(page);
    expect(connection.state).not.toBe('ALREADY_CONNECTED');
  });
});

describe('unknown pages fail safe', () => {
  it('classifies an unrecognised page as UNKNOWN_PAGE', async () => {
    await goto('/in/weird-page');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('UNKNOWN_PAGE');
  });

  it('does not optimistically report a profile when none rendered', async () => {
    await goto('/feed');
    // We asked for a profile but got the feed - that must not read as a profile.
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('UNKNOWN_PAGE');
  });

  it('a 404 for an unmapped slug is PROFILE_NOT_FOUND, not UNKNOWN_PAGE', async () => {
    await goto('/in/some-slug-with-no-fixture');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('PROFILE_NOT_FOUND');
  });
});

describe('session detection', () => {
  it('reports AUTHENTICATED for a signed-in feed', async () => {
    mock.setSessionFixture('feed-authenticated');
    const result = await detectSessionState(page, `${mock.url}/feed`, 20_000);
    expect(result.state).toBe('AUTHENTICATED');
  });

  it('reports LOGIN_REQUIRED when the session is gone', async () => {
    mock.setSessionFixture('login-required');
    const result = await detectSessionState(page, `${mock.url}/feed`, 20_000);
    expect(result.state).toBe('LOGIN_REQUIRED');
    mock.setSessionFixture('feed-authenticated');
  });

  it('reports CAPTCHA when the feed is behind a challenge', async () => {
    mock.setSessionFixture('captcha');
    const result = await detectSessionState(page, `${mock.url}/feed`, 20_000);
    expect(result.state).toBe('CAPTCHA');
    mock.setSessionFixture('feed-authenticated');
  });

  it('reports ACCOUNT_RESTRICTED when the account is flagged', async () => {
    mock.setSessionFixture('account-restricted');
    const result = await detectSessionState(page, `${mock.url}/feed`, 20_000);
    expect(result.state).toBe('ACCOUNT_RESTRICTED');
    mock.setSessionFixture('feed-authenticated');
  });

  it('reports NETWORK_ERROR when the host is unreachable', async () => {
    // Port 1 is reserved and refuses connections.
    const result = await detectSessionState(page, 'http://127.0.0.1:1/feed', 3_000);
    expect(result.state).toBe('NETWORK_ERROR');
  });
});

describe('detection never throws on a hostile page', () => {
  it('handles an empty document', async () => {
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('UNKNOWN_PAGE');
  });

  it('is not fooled by hidden security markup', async () => {
    // A CAPTCHA container present but hidden must NOT trigger a false stop -
    // visibility is required. Served from a real profile URL, because the
    // detector deliberately requires one before trusting a profile top card.
    await goto('/in/hidden-challenge-markup');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('CONNECT_AVAILABLE');
  });

  it('does stop on a VISIBLE captcha overlaying a profile', async () => {
    await goto('/in/visible-challenge-overlay');
    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('CAPTCHA');
  });

  it('will not treat a profile top card at a non-profile URL as a profile', async () => {
    // Profile-shaped markup served somewhere unexpected is not a profile. This
    // is why the hidden-captcha case above cannot use setContent.
    await page.setContent(`
      <nav class="global-nav"></nav>
      <main class="scaffold-layout__main">
        <section class="artdeco-card pv-top-card"><div class="ph5">
          <h1>Jane Doe</h1>
          <button aria-label="Invite Jane Doe to connect">Connect</button>
        </div></section>
      </main>`);

    const result = await detectPageState(page, { expectProfile: true });
    expect(result.state).toBe('UNKNOWN_PAGE');
  });
});
