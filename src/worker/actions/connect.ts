import type { Page } from 'playwright';

import type { PageState } from '@prisma/client';

import { profileNavigationUrl } from '../../lib/linkedin-url';
import { isNavigationTimeout } from '../browser';
import type { Logger } from '../logger';
import { detectConnectionState, detectPageState, ownerFromTitle } from '../page-state';

/**
 * The CONNECT action.
 *
 * Contract, and the reason this file is written the way it is: **clicking a
 * button is never treated as success**. The flow is always
 *
 *   navigate -> detect -> act -> re-detect -> decide
 *
 * and the value written to the database comes from the *re-detection*. If the
 * page does not confirm the invitation, the result is not `SENT`, even if every
 * click reported success.
 */

export type ConnectOutcome =
  | { kind: 'SENT'; verifiedBy: string; noteSent: boolean }
  | { kind: 'STATE'; state: PageState; matchedBy: string }
  | {
      kind: 'UNPROCESSABLE';
      reason: string;
      state: PageState;
    }
  | { kind: 'TECHNICAL_FAILURE'; message: string }
  | { kind: 'SAFETY'; state: PageState; matchedBy: string };

export interface ConnectParams {
  page: Page;
  linkedinUrl: string;
  logger: Logger;
  navTimeoutMs: number;
  /**
   * The finished connection note, or null to send a bare invitation.
   *
   * Rendering happens server-side, where the template, the lead data and the
   * configured length limit all live. By the time it reaches the worker it is
   * just text to type - the worker has no template logic and cannot produce a
   * half-substituted note.
   */
  note: string | null;
  /** Aborted when the emergency stop fires mid-job. */
  signal: AbortSignal;
  mockBaseUrl?: string;
}

const SAFETY_STATES: readonly PageState[] = [
  'CAPTCHA',
  'SECURITY_CHALLENGE',
  'ACCOUNT_RESTRICTED',
  'LOGIN_REQUIRED',
  'UNKNOWN_PAGE',
];

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError();
}

export class AbortError extends Error {
  constructor() {
    super('Aborted by emergency stop');
    this.name = 'AbortError';
  }
}

/**
 * Selectors for the invitation dialog. Grouped so a single markup change does
 * not blind the whole flow, and every one is verified as visible before use.
 */
const DIALOG = {
  root: ['div[role="dialog"]', '.artdeco-modal', '.send-invite'],
  addNote: [
    'button[aria-label="Add a note"]',
    'button:has-text("Add a note")',
    'button[aria-label*="Add a free note" i]',
  ],
  noteField: ['textarea#custom-message', 'textarea[name="message"]', 'textarea.send-invite__custom-message'],
  send: [
    // "Send without a note" first, and explicitly. A free LinkedIn account has
    // a small monthly allowance of personalised invitations; once it is spent
    // the dialog offers this instead. Relying on the loose `has-text("Send")`
    // below to catch it would be luck, since that also matches "Send with a
    // note" if LinkedIn ever renders both.
    'button[aria-label*="Send without a note" i]',
    'button:has-text("Send without a note")',
    'button[aria-label="Send invitation"]',
    'button[aria-label="Send now"]',
    'button[aria-label*="Send invitation" i]',
    'button:has-text("Send invitation")',
    'button:has-text("Send now")',
    'button:has-text("Send")',
  ],
  /**
   * "How do you know" / email-required variants. These cannot be completed
   * without information we do not have, so they are escalated, not guessed at.
   */
  emailRequired: [
    'input[name="email"]',
    'input#email',
    ':text("Please enter the email address")',
  ],
} as const;

async function clickFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = 4_000,
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      await locator.click({ timeout: timeoutMs });
      return selector;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * The name of the person whose profile this is, taken from the document title
 * ("Ada Lovelace | LinkedIn"). The title is the one part of the page that has
 * survived every redesign so far, and it is what makes the check below possible.
 */
export const profileOwnerFromTitle = ownerFromTitle;

/**
 * Find the Connect control **belonging to this profile's owner**.
 *
 * This is the most safety-critical selector in the project, and the reason it
 * cannot simply look for a Connect button: a profile page carries a "People
 * also viewed" sidebar, and every entry in it has its own Connect button. On a
 * real profile visited during testing, the *only* top-level Connect button on
 * the page belonged to a stranger in that sidebar - the owner's own Connect sat
 * inside the "More" overflow. Clicking "the first Connect button" would have
 * invited the wrong person, silently and unrecoverably.
 *
 * So the button is identified by what its label says it will do. LinkedIn
 * renders `aria-label="Invite <full name> to connect"`, and we require that
 * name to be the profile owner's. A button that does not name them is not
 * clicked, whatever it says on its face.
 */
async function findOwnerConnectButton(
  page: Page,
  owner: string,
  logger: Logger,
): Promise<{ selector: string; opened: boolean } | null> {
  // Deliberately NOT scoped to <button>. On current profiles the owner's own
  // Connect renders as a <div>, while the sidebar stranger's renders as a
  // <button> - so scoping by tag finds exactly the wrong element.
  // Names legitimately contain quotes and backslashes; both would break out of
  // the attribute selector and match something unintended.
  const escaped = owner.replace(/["\\]/g, '\\$&');
  const exact = `[aria-label="Invite ${escaped} to connect"]`;

  const visible = async (selector: string): Promise<boolean> => {
    try {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: 2_500 });
      return true;
    } catch {
      return false;
    }
  };

  if (await visible(exact)) return { selector: exact, opened: false };

  // Not on the surface. On current layouts the owner's Connect is inside the
  // profile card's overflow menu, alongside "Save to PDF" and "Report / Block".
  const mores = page.locator('main').locator('button[aria-label="More"]');
  const count = await mores.count();

  for (let i = 0; i < count; i += 1) {
    const button = mores.nth(i);
    const box = await button.boundingBox();
    // The sticky header carries its own "More" that sits under the nav bar and
    // cannot be clicked; skip anything at the very top of the viewport.
    if (!box || box.y < 80) continue;

    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 6_000 });
      await page.waitForTimeout(1_200);
    } catch {
      continue;
    }

    if (await visible(exact)) {
      logger.debug('Owner connect found in the profile overflow menu', { owner });
      return { selector: exact, opened: true };
    }

    // Wrong menu - close it before trying the next candidate.
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }

  return null;
}

async function findFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = 2_500,
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      return selector;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Perform (or decline to perform) a connection request for one lead.
 *
 * Never throws for an expected LinkedIn state - those come back as outcomes.
 * Throws only `AbortError` (emergency stop) and genuinely unexpected errors.
 */
export async function performConnect(params: ConnectParams): Promise<ConnectOutcome> {
  const { page, logger, signal, note } = params;

  throwIfAborted(signal);

  // --- 1. Navigate --------------------------------------------------------
  const target = profileNavigationUrl(params.linkedinUrl, params.mockBaseUrl);

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: params.navTimeoutMs });
  } catch (error) {
    if (isNavigationTimeout(error)) {
      return {
        kind: 'TECHNICAL_FAILURE',
        message: `Navigation to the profile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    throw error;
  }

  throwIfAborted(signal);

  // --- 2. Detect before acting -------------------------------------------
  const before = await detectPageState(page, { expectProfile: true });
  logger.info('Profile page classified', {
    state: before.state,
    matchedBy: before.matchedBy,
  });

  if (SAFETY_STATES.includes(before.state)) {
    return { kind: 'SAFETY', state: before.state, matchedBy: before.matchedBy };
  }

  if (before.state === 'NETWORK_ERROR') {
    return { kind: 'TECHNICAL_FAILURE', message: `Network error on profile: ${before.matchedBy}` };
  }

  // Nothing to do - these are normal, terminal outcomes.
  if (
    before.state === 'ALREADY_CONNECTED' ||
    before.state === 'INVITATION_PENDING' ||
    before.state === 'PROFILE_NOT_FOUND'
  ) {
    return { kind: 'STATE', state: before.state, matchedBy: before.matchedBy };
  }

  if (before.state !== 'CONNECT_AVAILABLE') {
    return {
      kind: 'UNPROCESSABLE',
      reason: `Profile loaded but no connect action was available (${before.matchedBy}). Not guessing what to click.`,
      state: before.state,
    };
  }

  // --- 3. Act -------------------------------------------------------------
  throwIfAborted(signal);

  const owner = profileOwnerFromTitle(await page.title());
  if (!owner) {
    return {
      kind: 'UNPROCESSABLE',
      reason: 'Could not read whose profile this is from the page title; refusing to click.',
      state: before.state,
    };
  }

  const found = await findOwnerConnectButton(page, owner, logger);
  if (!found) {
    return {
      kind: 'UNPROCESSABLE',
      reason: `No Connect control naming "${owner}" was found on their own profile.`,
      state: before.state,
    };
  }

  const connectSelector = found.selector;
  try {
    await page.locator(connectSelector).first().click({ timeout: 6_000 });
  } catch {
    return {
      kind: 'UNPROCESSABLE',
      reason: 'The connect control was found but could not be clicked.',
      state: before.state,
    };
  }

  logger.debug('Clicked connect', { selector: connectSelector });
  throwIfAborted(signal);

  const dialog = await findFirstVisible(page, DIALOG.root, 5_000);
  if (!dialog) {
    // Some profiles send immediately with no dialog. Verification below decides.
    logger.debug('No invitation dialog appeared; verifying resulting state directly');
  } else {
    // An email-gated invitation cannot be completed with the data we hold.
    const emailGate = await findFirstVisible(page, DIALOG.emailRequired, 1_000);
    if (emailGate) {
      await dismissDialog(page);
      return {
        kind: 'UNPROCESSABLE',
        reason:
          'LinkedIn requires this person’s email address to send an invitation. Skipped rather than guessing.',
        state: 'PROFILE_FOUND',
      };
    }

    if (note) {
      const addNote = await clickFirstVisible(page, DIALOG.addNote, 2_500);
      const field = await findFirstVisible(page, DIALOG.noteField, 2_500);

      if (field) {
        await page.locator(field).first().fill(note);
        logger.debug('Filled connection note', { chars: note.length, addNoteClicked: !!addNote });
      } else {
        // Note requested but no field available (e.g. free-account note limit
        // reached). Escalate rather than silently sending a bare invitation
        // that the operator did not choose to send.
        await dismissDialog(page);
        return {
          kind: 'UNPROCESSABLE',
          reason:
            'A connection note was configured but LinkedIn offered no note field on this profile. ' +
            'Skipped rather than silently sending an invitation with no note.',
          state: 'PROFILE_FOUND',
        };
      }
    }

    throwIfAborted(signal);

    const sendSelector = await clickFirstVisible(page, DIALOG.send, 5_000);
    if (!sendSelector) {
      await dismissDialog(page);
      return {
        kind: 'UNPROCESSABLE',
        reason: 'The invitation dialog opened but no send control could be found.',
        state: 'PROFILE_FOUND',
      };
    }
    logger.debug('Clicked send', { selector: sendSelector });
  }

  // --- 4. Verify ----------------------------------------------------------
  // This is the step that decides the outcome. The click above proves nothing.
  throwIfAborted(signal);

  const verification = await verifyInvitationSent(page, params.navTimeoutMs);

  if (verification.state === 'INVITATION_PENDING') {
    return { kind: 'SENT', verifiedBy: verification.matchedBy, noteSent: note !== null };
  }

  if (SAFETY_STATES.includes(verification.state)) {
    return { kind: 'SAFETY', state: verification.state, matchedBy: verification.matchedBy };
  }

  if (verification.state === 'ALREADY_CONNECTED') {
    // Auto-accepted, or they were connected already and the badge was missed.
    return { kind: 'STATE', state: 'ALREADY_CONNECTED', matchedBy: verification.matchedBy };
  }

  // Could not confirm. Reported honestly as unverified rather than as SENT.
  return {
    kind: 'UNPROCESSABLE',
    reason:
      `Clicked send but could not confirm the invitation from the page afterwards ` +
      `(page reads as ${verification.state}: ${verification.matchedBy}). ` +
      'Recorded as unverified so it is reviewed by a person rather than counted as sent.',
    state: verification.state,
  };
}

/**
 * Re-read the page to confirm the invitation.
 *
 * Reloads the profile rather than trusting the post-click DOM, because the
 * in-page state after a modal closes is not a reliable indicator.
 */
async function verifyInvitationSent(
  page: Page,
  navTimeoutMs: number,
): Promise<{ state: PageState; matchedBy: string }> {
  // First, the cheap in-page check: a "Pending" affordance appearing without a
  // reload is strong, immediate confirmation.
  const quick = await findFirstVisible(
    page,
    ['button[aria-label*="Pending" i]', 'button:has-text("Pending")', 'button[aria-label*="Withdraw invitation" i]'],
    3_000,
  );
  if (quick) {
    return { state: 'INVITATION_PENDING', matchedBy: `post-click dom:${quick}` };
  }

  // Otherwise reload and classify from scratch.
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  } catch (error) {
    return {
      state: 'NETWORK_ERROR',
      matchedBy: `verification reload failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const full = await detectPageState(page, { expectProfile: true });
  if (full.state === 'PROFILE_FOUND' || full.state === 'CONNECT_AVAILABLE') {
    // Ask about this profile's owner, not about any Connect button on the page.
    const owner = profileOwnerFromTitle(await page.title());
    const connection = await detectConnectionState(page, owner);
    return { state: connection.state, matchedBy: `after reload: ${connection.matchedBy}` };
  }
  return { state: full.state, matchedBy: `after reload: ${full.matchedBy}` };
}

/** Close a dialog we decided not to complete, so the page is left clean. */
async function dismissDialog(page: Page): Promise<void> {
  const dismissed = await clickFirstVisible(
    page,
    [
      'button[aria-label="Dismiss"]',
      'button[aria-label="Cancel"]',
      '.artdeco-modal__dismiss',
      'button:has-text("Cancel")',
    ],
    2_000,
  );
  if (!dismissed) {
    try {
      await page.keyboard.press('Escape');
    } catch {
      // Leaving a dialog open is harmless; the next job navigates away.
    }
  }
}
