import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import type { Logger } from './logger';

/**
 * Persistent browser session.
 *
 * The session is a real Chromium profile directory on disk, created once by a
 * human logging in by hand (`npm run worker -- --login`). The worker reuses that
 * profile and never sees, requests, stores or transmits a LinkedIn password.
 *
 * There is deliberately nothing here that tries to look like a different
 * browser: no fingerprint patching, no stealth plugin, no proxy rotation, no
 * automation-flag hiding. The browser identifies itself honestly. If LinkedIn
 * asks for verification, the worker stops and a person deals with it.
 */

export const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';
export const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';

export interface BrowserOptions {
  profileDir: string;
  headless: boolean;
  navTimeoutMs: number;
  logger: Logger;
  /** Test-only origin override. Never set outside NODE_ENV=test. */
  mockBaseUrl?: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launch (or re-attach to) the persistent profile.
 *
 * `launchPersistentContext` is what makes the login survive restarts: cookies
 * and local storage live in `profileDir`, not in memory.
 */
export async function launchPersistentSession(
  options: BrowserOptions,
): Promise<BrowserSession> {
  const profileDir = resolve(options.profileDir);
  await mkdir(profileDir, { recursive: true });

  options.logger.info('Launching browser with persistent profile', {
    profileDir,
    headless: options.headless,
  });

  // Stock Chromium with default flags. No anti-detection arguments, no
  // fingerprint patching, no user-agent spoofing - the browser is honest about
  // what it is.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    viewport: { width: 1440, height: 900 },
  });

  context.setDefaultNavigationTimeout(options.navTimeoutMs);
  context.setDefaultTimeout(Math.min(options.navTimeoutMs, 20_000));

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    async close() {
      try {
        await context.close();
      } catch (error) {
        options.logger.warn('Browser context did not close cleanly', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Interactive, human-driven login.
 *
 * Opens a visible browser at the LinkedIn sign-in page and waits for the
 * operator to authenticate themselves - including any two-factor step or
 * verification LinkedIn asks for. Nothing is typed, filled or solved
 * programmatically; this only detects when a logged-in session exists and then
 * persists it in the profile directory.
 */
export async function runInteractiveLogin(options: {
  profileDir: string;
  navTimeoutMs: number;
  logger: Logger;
  /** How long to wait for the human to finish. */
  waitMs?: number;
}): Promise<'AUTHENTICATED' | 'TIMED_OUT'> {
  const session = await launchPersistentSession({
    profileDir: options.profileDir,
    headless: false,
    navTimeoutMs: options.navTimeoutMs,
    logger: options.logger,
  });

  const deadline = Date.now() + (options.waitMs ?? 10 * 60_000);

  try {
    await session.page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });

    options.logger.info(
      'Browser window is open. Sign in to LinkedIn by hand, complete any verification ' +
        'LinkedIn asks for, and leave the window open until this process confirms the session.',
    );

    // Poll for the authenticated feed. Import is local to avoid a cycle:
    // page-state imports nothing from this module.
    const { detectPageState } = await import('./page-state');

    while (Date.now() < deadline) {
      await session.page.waitForTimeout(3_000);

      const state = await detectPageState(session.page);
      if (state.state === 'AUTHENTICATED') {
        options.logger.info('Signed-in session detected and saved to the browser profile.', {
          profileDir: options.profileDir,
        });
        return 'AUTHENTICATED';
      }
      if (state.state === 'CAPTCHA' || state.state === 'SECURITY_CHALLENGE') {
        options.logger.warn(
          'LinkedIn is asking for verification. Complete it yourself in the open window - ' +
            'this process will not attempt it.',
          { state: state.state },
        );
      }
    }

    options.logger.error('Timed out waiting for a signed-in session.');
    return 'TIMED_OUT';
  } finally {
    await session.close();
  }
}

/**
 * Screenshot for an incident.
 *
 * Returns the saved path, or null on failure - a screenshot is diagnostic
 * evidence and its absence must never mask the incident itself.
 */
export async function captureScreenshot(
  page: Page,
  screenshotDir: string,
  label: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const dir = resolve(screenshotDir);
    await mkdir(dir, { recursive: true });

    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = resolve(dir, `${stamp}_${safeLabel}.png`);

    await page.screenshot({ path, fullPage: false });
    return path;
  } catch (error) {
    logger.warn('Screenshot capture failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Classify a navigation failure so the caller can pick the right error class. */
export function isNavigationTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|net::ERR_|ERR_NETWORK|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(message);
}
