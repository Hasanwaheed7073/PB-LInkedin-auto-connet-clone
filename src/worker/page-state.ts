import type { Locator, Page } from 'playwright';

import type { PageState } from '@prisma/client';

/**
 * Deterministic page-state detection.
 *
 * No model is involved. Every classification comes from an explicit, ordered
 * list of URL and DOM rules, and the fallback is `UNKNOWN_PAGE`, which halts the
 * worker. That default is the whole point: an unrecognised page is treated as
 * dangerous rather than as "probably fine, click something".
 *
 * Rule order is safety-first. Security states are checked before anything else,
 * so a CAPTCHA rendered over a profile page is never mistaken for a profile.
 *
 * MAINTENANCE NOTE: LinkedIn changes its markup regularly, so these selectors
 * will drift. When they do, detection degrades to `UNKNOWN_PAGE` and the worker
 * stops - it does not start guessing. Fix the selectors here; do not loosen the
 * fallback.
 *
 * The text patterns target LinkedIn's English UI. Running the account in another
 * display language will degrade detection to UNKNOWN_PAGE (safe, but it stops
 * work), so keep the LinkedIn interface language set to English.
 */

export interface DetectionResult {
  state: PageState;
  /** Which rule fired, for the activity log and for debugging selector drift. */
  matchedBy: string;
  url: string;
  title: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// URL signatures
// ---------------------------------------------------------------------------

const URL_PATTERNS = {
  captcha: [/\/checkpoint\/challenge/i, /captcha/i, /\/checkpoint\/rp\/request-password-reset/i],
  securityChallenge: [
    /\/checkpoint\/lg\/login-submit/i,
    /\/checkpoint\/challengesV2/i,
    /\/checkpoint\/post-login\/security/i,
    /\/uas\/consumer-email-challenge/i,
    /\/checkpoint\/rm\//i,
  ],
  restricted: [
    /\/checkpoint\/restricted/i,
    /\/help\/linkedin\/answer\/\d+.*restricted/i,
    /\/psettings\/member-restriction/i,
  ],
  login: [
    /\/login(\?|$|\/)/i,
    /\/uas\/login/i,
    /\/authwall/i,
    /\/signup(\?|$|\/)/i,
    /\/checkpoint\/lg\/sign-in/i,
  ],
  notFound: [/\/404(\?|$|\/)/i, /\/in\/unavailable/i],
  profile: [/\/in\/[^/]+/i],
} as const;

// ---------------------------------------------------------------------------
// DOM signatures
// ---------------------------------------------------------------------------

/**
 * Selectors are grouped by meaning, and every group is a list so a single
 * markup change does not blind a whole detector.
 */
const SELECTORS = {
  captcha: [
    'iframe[src*="captcha"]',
    'iframe[title*="captcha" i]',
    '#captcha-internal',
    '.captcha-container',
    'div[data-test-id*="captcha" i]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="funcaptcha"]',
    'iframe[src*="arkoselabs"]',
  ],
  securityChallenge: [
    'form[action*="checkpoint"]',
    'input[name="pin"]',
    '#input__email_verification_pin',
    'div.challenge-dialog',
    '[data-test-id="challenge"]',
    'h1:has-text("Let\'s do a quick security check")',
    'h1:has-text("Help us keep your account safe")',
  ],
  restricted: [
    'h1:has-text("account has been restricted")',
    'h1:has-text("Your account has been temporarily restricted")',
    ':text("We\'ve restricted your account")',
    ':text("temporarily restricted")',
    ':text("Your account is restricted")',
  ],
  login: [
    'form.login__form',
    'input#username',
    'input[name="session_key"]',
    'button[data-id="sign-in-form__submit-btn"]',
    '.authwall',
    'a[href*="/login"]:has-text("Sign in")',
  ],
  notFound: [
    ':text("This page doesn\'t exist")',
    ':text("Page not found")',
    '.not-found__main',
    'h1:has-text("Page not found")',
  ],
  /** Anchor proving an authenticated session-chrome is present. */
  /**
   * Proof that a signed-in page rendered.
   *
   * Navigation destinations first, deliberately. LinkedIn now ships hashed
   * class names (`_5dc4a4cd`, `_723e1cfe`) that change with every build, so a
   * class-based signature is guaranteed to rot - the five legacy selectors
   * below match nothing on the current site and are kept only in case an older
   * surface is served.
   *
   * These hrefs are the product's URL structure rather than its styling, and
   * all three are absent from a logged-out page: visiting /feed/ signed out
   * redirects to /login/, which carries none of them. Verified against both
   * states before being trusted, because a false AUTHENTICATED lets the worker
   * proceed believing it is signed in.
   */
  authenticatedChrome: [
    'a[href*="/mynetwork"]',
    'a[href*="/notifications"]',
    'a[href*="/messaging"]',
    'nav.global-nav',
    '#global-nav',
    'header.global-nav',
    'img.global-nav__me-photo',
    'button[data-control-name="identity_welcome_message"]',
  ],
  /** Anchor proving a profile top card rendered. */
  profileTopCard: [
    'section.artdeco-card div.ph5',
    'main section:first-of-type h1',
    '.pv-top-card',
    '[data-member-id]',
    'div.scaffold-layout__main h1',
  ],
} as const;

/** Buttons expressing the current connection state. */
const CONNECTION_SELECTORS = {
  pending: [
    'button[aria-label*="Pending" i]',
    'button:has-text("Pending")',
    'span.artdeco-button__text:has-text("Pending")',
    'button[aria-label*="Withdraw invitation" i]',
  ],
  connect: [
    'button[aria-label^="Invite" i][aria-label*="connect" i]',
    'button[aria-label*="to connect" i]',
    'button.artdeco-button--primary:has-text("Connect")',
    'button:has-text("Connect")',
  ],
  message: [
    'button[aria-label^="Message" i]',
    'button.artdeco-button--primary:has-text("Message")',
    'a[href*="/messaging/thread"]',
  ],
  /** First-degree connection badge on the top card. */
  firstDegree: [
    'span.dist-value:has-text("1st")',
    'span:has-text("· 1st")',
    '[aria-label*="1st degree connection" i]',
    'span.distance-badge:has-text("1st")',
  ],
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const VISIBILITY_TIMEOUT_MS = 900;

/**
 * Is any of these selectors present and visible?
 *
 * Probes run CONCURRENTLY, not in sequence. That matters a great deal: a page
 * matching nothing has to miss on every selector, and a sequential loop would
 * pay the timeout once per selector - roughly forty seconds per detection across
 * all the groups here, on every job. In parallel, a total miss costs one
 * timeout.
 *
 * Priority is still selector order: the result is picked by scanning the
 * original array, not by whichever probe happened to resolve first. That keeps
 * detection deterministic, which is the property the whole module depends on.
 */
async function anyVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = VISIBILITY_TIMEOUT_MS,
): Promise<{ found: boolean; selector: string | null }> {
  const probes = await Promise.all(
    selectors.map(async (selector) => {
      try {
        const locator: Locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        return selector;
      } catch {
        // Not present, not visible, or the page navigated. A miss is not an error.
        return null;
      }
    }),
  );

  const found = probes.find((selector) => selector !== null) ?? null;
  return { found: found !== null, selector: found };
}

function matchesAny(url: string, patterns: readonly RegExp[]): RegExp | null {
  for (const pattern of patterns) {
    if (pattern.test(url)) return pattern;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public detectors
// ---------------------------------------------------------------------------

/**
 * Classify the page currently loaded.
 *
 * `expectProfile` tightens the result when we navigated to a profile: a page
 * that shows no profile top card and no other recognised signature is
 * `UNKNOWN_PAGE` rather than optimistically `PROFILE_FOUND`.
 */
export async function detectPageState(
  page: Page,
  options: { expectProfile?: boolean } = {},
): Promise<DetectionResult> {
  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {
    // A crashed or navigating page can refuse title(); not fatal for detection.
  }

  const base = { url, title };

  // --- 1. Security states, checked first and unconditionally --------------

  const captchaUrl = matchesAny(url, URL_PATTERNS.captcha);
  if (captchaUrl) {
    return { ...base, state: 'CAPTCHA', matchedBy: `url:${captchaUrl.source}` };
  }

  const captchaDom = await anyVisible(page, SELECTORS.captcha);
  if (captchaDom.found) {
    return { ...base, state: 'CAPTCHA', matchedBy: `dom:${captchaDom.selector}` };
  }

  const restrictedUrl = matchesAny(url, URL_PATTERNS.restricted);
  if (restrictedUrl) {
    return { ...base, state: 'ACCOUNT_RESTRICTED', matchedBy: `url:${restrictedUrl.source}` };
  }

  const restrictedDom = await anyVisible(page, SELECTORS.restricted);
  if (restrictedDom.found) {
    return { ...base, state: 'ACCOUNT_RESTRICTED', matchedBy: `dom:${restrictedDom.selector}` };
  }

  const challengeUrl = matchesAny(url, URL_PATTERNS.securityChallenge);
  if (challengeUrl) {
    return { ...base, state: 'SECURITY_CHALLENGE', matchedBy: `url:${challengeUrl.source}` };
  }

  const challengeDom = await anyVisible(page, SELECTORS.securityChallenge);
  if (challengeDom.found) {
    return { ...base, state: 'SECURITY_CHALLENGE', matchedBy: `dom:${challengeDom.selector}` };
  }

  // A bare /checkpoint/ URL that matched none of the specific patterns above is
  // still a checkpoint. Treat it as a challenge rather than guessing.
  if (/\/checkpoint\//i.test(url)) {
    return { ...base, state: 'SECURITY_CHALLENGE', matchedBy: 'url:/checkpoint/ (generic)' };
  }

  // --- 2. Authentication --------------------------------------------------

  const loginUrl = matchesAny(url, URL_PATTERNS.login);
  if (loginUrl) {
    return { ...base, state: 'LOGIN_REQUIRED', matchedBy: `url:${loginUrl.source}` };
  }

  const loginDom = await anyVisible(page, SELECTORS.login);
  if (loginDom.found) {
    return { ...base, state: 'LOGIN_REQUIRED', matchedBy: `dom:${loginDom.selector}` };
  }

  // --- 3. Missing profile -------------------------------------------------

  const notFoundUrl = matchesAny(url, URL_PATTERNS.notFound);
  if (notFoundUrl) {
    return { ...base, state: 'PROFILE_NOT_FOUND', matchedBy: `url:${notFoundUrl.source}` };
  }

  const notFoundDom = await anyVisible(page, SELECTORS.notFound);
  if (notFoundDom.found) {
    return { ...base, state: 'PROFILE_NOT_FOUND', matchedBy: `dom:${notFoundDom.selector}` };
  }

  // --- 4. Connection state on a profile ----------------------------------

  const onProfileUrl = matchesAny(url, URL_PATTERNS.profile) !== null;
  const topCard = await anyVisible(page, SELECTORS.profileTopCard);

  if (onProfileUrl && topCard.found) {
    const connection = await detectConnectionState(page);
    return {
      ...base,
      state: connection.state,
      matchedBy: connection.matchedBy,
      detail: connection.detail,
    };
  }

  // --- 5. Authenticated but not where we expected -------------------------

  const chrome = await anyVisible(page, SELECTORS.authenticatedChrome);

  if (options.expectProfile) {
    // We asked for a profile and did not get one. Never optimistic here.
    return {
      ...base,
      state: 'UNKNOWN_PAGE',
      matchedBy: chrome.found
        ? 'authenticated chrome present but no profile top card'
        : 'no recognised page signature',
      detail: { onProfileUrl, topCardFound: topCard.found, chromeFound: chrome.found },
    };
  }

  if (chrome.found) {
    return { ...base, state: 'AUTHENTICATED', matchedBy: `dom:${chrome.selector}` };
  }

  return { ...base, state: 'UNKNOWN_PAGE', matchedBy: 'no recognised page signature' };
}

export interface ConnectionDetection {
  state: Extract<
    PageState,
    'ALREADY_CONNECTED' | 'INVITATION_PENDING' | 'CONNECT_AVAILABLE' | 'PROFILE_FOUND'
  >;
  matchedBy: string;
  detail: Record<string, unknown>;
}

/**
 * Determine the connection state on a loaded profile.
 *
 * Order matters and is chosen so an ambiguous page never reads as "safe to
 * send":
 *  1. Pending wins outright - an outstanding invitation means do nothing.
 *  2. A first-degree badge means already connected.
 *  3. Only then is an available Connect affordance trusted.
 *  4. Anything else is `PROFILE_FOUND`, which the CONNECT action escalates for
 *     review rather than acting on.
 */
export async function detectConnectionState(page: Page): Promise<ConnectionDetection> {
  const pending = await anyVisible(page, CONNECTION_SELECTORS.pending);
  if (pending.found) {
    return {
      state: 'INVITATION_PENDING',
      matchedBy: `dom:${pending.selector}`,
      detail: { signal: 'pending-button' },
    };
  }

  const firstDegree = await anyVisible(page, CONNECTION_SELECTORS.firstDegree);
  if (firstDegree.found) {
    return {
      state: 'ALREADY_CONNECTED',
      matchedBy: `dom:${firstDegree.selector}`,
      detail: { signal: 'first-degree-badge' },
    };
  }

  const connect = await anyVisible(page, CONNECTION_SELECTORS.connect);
  if (connect.found) {
    return {
      state: 'CONNECT_AVAILABLE',
      matchedBy: `dom:${connect.selector}`,
      detail: { signal: 'connect-button', selector: connect.selector },
    };
  }

  // A Message button with no Connect and no degree badge is a weak signal. It is
  // deliberately NOT treated as already-connected: it is also what an
  // out-of-network profile with messaging enabled looks like.
  const message = await anyVisible(page, CONNECTION_SELECTORS.message);

  return {
    state: 'PROFILE_FOUND',
    matchedBy: message.found
      ? 'profile loaded; message affordance only, connection state ambiguous'
      : 'profile loaded; no connection affordance found',
    detail: { messageButtonFound: message.found },
  };
}

/**
 * Session check for the dashboard indicator and worker start-up.
 *
 * Navigates to the LinkedIn feed and classifies what comes back. Performs no
 * outreach and clicks nothing.
 */
export async function detectSessionState(
  page: Page,
  feedUrl: string,
  navTimeoutMs: number,
): Promise<DetectionResult> {
  try {
    await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  } catch (error) {
    return {
      state: 'NETWORK_ERROR',
      matchedBy: 'navigation failed',
      url: feedUrl,
      title: '',
      detail: { message: error instanceof Error ? error.message : String(error) },
    };
  }
  return detectPageState(page);
}

/** Exposed for the detector unit tests, which assert on fixture pages. */
export const DETECTOR_INTERNALS = {
  URL_PATTERNS,
  SELECTORS,
  CONNECTION_SELECTORS,
  anyVisible,
  matchesAny,
};
