/**
 * Mock LinkedIn page fixtures.
 *
 * These reproduce the *shape* of the markup the detector looks for - the
 * selectors, aria-labels and URL patterns - so the real worker, the real
 * Playwright browser and the real detector can be exercised end to end without
 * ever contacting LinkedIn.
 *
 * They are deliberately not pixel-accurate copies of LinkedIn's pages, and
 * contain no LinkedIn assets, styles or copy beyond the short UI strings the
 * detector matches on.
 */

export type FixtureName =
  | 'feed-authenticated'
  | 'login-required'
  | 'profile-connect-available'
  | 'profile-already-connected'
  | 'profile-invitation-pending'
  | 'profile-no-affordance'
  | 'profile-not-found'
  | 'captcha'
  | 'security-challenge'
  | 'account-restricted'
  | 'unknown-page'
  | 'profile-connect-then-pending'
  | 'profile-connect-email-required'
  | 'profile-connect-no-note-field'
  | 'profile-hidden-captcha'
  | 'profile-captcha-overlay';

function shell(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
    nav.global-nav { height: 52px; background: #f3f2ef; display: flex; align-items: center; padding: 0 16px; }
    main { padding: 24px; max-width: 900px; }
    .artdeco-card { border: 1px solid #e0dfdc; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .artdeco-button { padding: 6px 16px; border-radius: 16px; border: 1px solid #0a66c2; background: #fff; cursor: pointer; font-size: 14px; }
    .artdeco-button--primary { background: #0a66c2; color: #fff; }
    .artdeco-modal { position: fixed; inset: 20% 25%; background: #fff; border: 1px solid #ccc; border-radius: 8px; padding: 24px; box-shadow: 0 8px 32px rgba(0,0,0,.2); }
    [hidden] { display: none !important; }
    textarea { width: 100%; min-height: 90px; }
  </style>
  ${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

const GLOBAL_NAV = `
<nav class="global-nav" id="global-nav">
  <span>Mock LinkedIn</span>
  <img class="global-nav__me-photo" alt="Me" width="24" height="24"
       src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
</nav>`;

/** Profile top card. `degree` renders the connection-distance badge. */
function topCard(options: {
  name: string;
  headline?: string;
  degree?: '1st' | '2nd' | '3rd' | null;
  buttons: string;
}): string {
  const badge = options.degree
    ? `<span class="dist-value">${options.degree}</span>`
    : '';
  return `
<main class="scaffold-layout__main">
  <section class="artdeco-card pv-top-card" data-member-id="12345">
    <div class="ph5">
      <h1>${options.name}</h1>
      <div class="text-body-medium">${options.headline ?? 'Clinical Research Associate at Acme Clinical'}</div>
      <span class="distance-badge">${badge}</span>
      <div class="pv-top-card-v2-ctas">
        ${options.buttons}
      </div>
    </div>
  </section>
  ${BROWSEMAP_SIDEBAR}
</main>`;
}

/**
 * "People also viewed", reproduced because of what it did in production.
 *
 * Every entry carries its own Connect button, and on the real site the
 * stranger's button is a `<button>` while the profile owner's own control is a
 * `<div>` tucked inside an overflow menu. Code that looked for "a Connect
 * button" therefore found this one - the wrong person - and code that verified
 * a send by looking for "a Connect button" found it again and concluded nothing
 * had been sent, while four real invitations had gone out.
 *
 * Present in every profile fixture so neither mistake can return unnoticed: a
 * test that clicks or reads this element is a test that would have shipped the
 * bug.
 */
const BROWSEMAP_SIDEBAR = `
<aside data-view-name="profile-browsemap">
  <section class="artdeco-card" data-view-name="profile-browsemap-entity">
    <span>Hamza Farooq Muhammadi</span>
    <button class="artdeco-button" aria-label="Invite Hamza Farooq Muhammadi to connect">Connect</button>
  </section>
  <section class="artdeco-card" data-view-name="profile-browsemap-entity">
    <span>Puneet Gupta</span>
    <button class="artdeco-button" aria-label="Invite Puneet Gupta to connect">Connect</button>
  </section>
</aside>`;

const CONNECT_BUTTON = `<button class="artdeco-button artdeco-button--primary"
  aria-label="Invite Jane Doe to connect">Connect</button>`;

const MESSAGE_BUTTON = `<button class="artdeco-button artdeco-button--primary"
  aria-label="Message Jane Doe">Message</button>`;

const PENDING_BUTTON = `<button class="artdeco-button"
  aria-label="Pending, click to withdraw invitation sent to Jane Doe">Pending</button>`;

const FOLLOW_BUTTON = `<button class="artdeco-button" aria-label="Follow Jane Doe">Follow</button>`;

/**
 * Interactive fixture: clicking Connect opens the invitation dialog; sending it
 * swaps the primary button to "Pending", which is exactly the state transition
 * the worker verifies against.
 */
const CONNECT_FLOW_SCRIPT = `
<script>
  function byId(id) { return document.getElementById(id); }
  window.addEventListener('DOMContentLoaded', function () {
    var connect = byId('connect-btn');
    var dialog = byId('invite-dialog');
    var addNote = byId('add-note-btn');
    var noteWrap = byId('note-wrap');
    var send = byId('send-btn');
    var dismiss = byId('dismiss-btn');
    var ctas = byId('ctas');

    if (connect) connect.addEventListener('click', function () { dialog.hidden = false; });
    if (addNote) addNote.addEventListener('click', function () {
      if (noteWrap) noteWrap.hidden = false;
      addNote.hidden = true;
    });
    if (dismiss) dismiss.addEventListener('click', function () { dialog.hidden = true; });
    if (send) send.addEventListener('click', function () {
      dialog.hidden = true;
      // Record what was actually typed so tests can assert on the note.
      var note = byId('custom-message');
      window.__sentNote = note ? note.value : null;
      window.__invitationSent = true;
      ctas.innerHTML =
        '<button class="artdeco-button" aria-label="Pending, click to withdraw invitation">Pending</button>';
    });
  });
</script>`;

function inviteDialog(options: { withNoteField: boolean; emailRequired?: boolean }): string {
  if (options.emailRequired) {
    return `
<div class="artdeco-modal" id="invite-dialog" role="dialog" hidden>
  <h2>How do you know Jane?</h2>
  <p>Please enter the email address to connect.</p>
  <input type="email" id="email" name="email" placeholder="Email">
  <button class="artdeco-button" id="dismiss-btn" aria-label="Dismiss">Cancel</button>
</div>`;
  }

  return `
<div class="artdeco-modal" id="invite-dialog" role="dialog" hidden>
  <h2>Add a note to your invitation?</h2>
  ${
    options.withNoteField
      ? `<button class="artdeco-button" id="add-note-btn" aria-label="Add a note">Add a note</button>
         <div id="note-wrap" hidden>
           <textarea id="custom-message" name="message" class="send-invite__custom-message"
                     maxlength="300" placeholder="Add a note"></textarea>
         </div>`
      : `<p>No note can be added to this invitation.</p>`
  }
  <button class="artdeco-button" id="dismiss-btn" aria-label="Dismiss">Cancel</button>
  <button class="artdeco-button artdeco-button--primary" id="send-btn"
          aria-label="Send invitation">Send invitation</button>
</div>`;
}

export const FIXTURES: Record<FixtureName, string> = {
  // --- Session states ----------------------------------------------------
  'feed-authenticated': shell(
    'Feed | Mock LinkedIn',
    `${GLOBAL_NAV}<main><h1>Your feed</h1><p>Signed in.</p></main>`,
  ),

  'login-required': shell(
    'Sign In | Mock LinkedIn',
    `<main>
      <form class="login__form">
        <h1>Sign in</h1>
        <input id="username" name="session_key" type="text" placeholder="Email">
        <input id="password" name="session_password" type="password" placeholder="Password">
        <button data-id="sign-in-form__submit-btn" type="submit">Sign in</button>
      </form>
    </main>`,
  ),

  // --- Profile connection states -----------------------------------------
  'profile-connect-available': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      topCard({ name: 'Jane Doe', degree: '2nd', buttons: `${CONNECT_BUTTON}${MESSAGE_BUTTON}` }),
  ),

  'profile-already-connected': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      topCard({ name: 'Jane Doe', degree: '1st', buttons: `${MESSAGE_BUTTON}${FOLLOW_BUTTON}` }),
  ),

  'profile-invitation-pending': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      topCard({ name: 'Jane Doe', degree: '2nd', buttons: `${PENDING_BUTTON}${MESSAGE_BUTTON}` }),
  ),

  // Loaded, but nothing actionable - must NOT be treated as safe to send.
  'profile-no-affordance': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV + topCard({ name: 'Jane Doe', degree: null, buttons: FOLLOW_BUTTON }),
  ),

  'profile-not-found': shell(
    'Page not found | Mock LinkedIn',
    `${GLOBAL_NAV}<main class="not-found__main"><h1>Page not found</h1>
     <p>This page doesn't exist</p></main>`,
  ),

  // --- Interactive connect flows -----------------------------------------
  'profile-connect-then-pending': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      `<main class="scaffold-layout__main">
        <section class="artdeco-card pv-top-card" data-member-id="12345">
          <div class="ph5">
            <h1>Jane Doe</h1>
            <span class="distance-badge"><span class="dist-value">2nd</span></span>
            <div class="pv-top-card-v2-ctas" id="ctas">
              <button class="artdeco-button artdeco-button--primary" id="connect-btn"
                      aria-label="Invite Jane Doe to connect">Connect</button>
              ${MESSAGE_BUTTON}
            </div>
          </div>
        </section>
      </main>` +
      inviteDialog({ withNoteField: true }) +
      CONNECT_FLOW_SCRIPT,
  ),

  'profile-connect-email-required': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      `<main class="scaffold-layout__main">
        <section class="artdeco-card pv-top-card" data-member-id="12345">
          <div class="ph5">
            <h1>Jane Doe</h1>
            <span class="distance-badge"><span class="dist-value">3rd</span></span>
            <div class="pv-top-card-v2-ctas" id="ctas">
              <button class="artdeco-button artdeco-button--primary" id="connect-btn"
                      aria-label="Invite Jane Doe to connect">Connect</button>
            </div>
          </div>
        </section>
      </main>` +
      inviteDialog({ withNoteField: false, emailRequired: true }) +
      CONNECT_FLOW_SCRIPT,
  ),

  'profile-connect-no-note-field': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      `<main class="scaffold-layout__main">
        <section class="artdeco-card pv-top-card" data-member-id="12345">
          <div class="ph5">
            <h1>Jane Doe</h1>
            <span class="distance-badge"><span class="dist-value">2nd</span></span>
            <div class="pv-top-card-v2-ctas" id="ctas">
              <button class="artdeco-button artdeco-button--primary" id="connect-btn"
                      aria-label="Invite Jane Doe to connect">Connect</button>
            </div>
          </div>
        </section>
      </main>` +
      inviteDialog({ withNoteField: false }) +
      CONNECT_FLOW_SCRIPT,
  ),

  // --- Security states ---------------------------------------------------
  'captcha': shell(
    'Security Verification | Mock LinkedIn',
    `<main>
      <h1>Let's do a quick security check</h1>
      <div class="captcha-container" id="captcha-internal">
        <iframe title="captcha challenge" src="about:blank" width="300" height="200"></iframe>
      </div>
    </main>`,
  ),

  'security-challenge': shell(
    'Security Verification | Mock LinkedIn',
    `<main>
      <div class="challenge-dialog" data-test-id="challenge">
        <h1>Help us keep your account safe</h1>
        <form action="/checkpoint/challenge/verify">
          <label for="input__email_verification_pin">Enter the code we emailed you</label>
          <input id="input__email_verification_pin" name="pin" type="text">
          <button type="submit">Verify</button>
        </form>
      </div>
    </main>`,
  ),

  'account-restricted': shell(
    'Account Restricted | Mock LinkedIn',
    `<main>
      <h1>Your account has been temporarily restricted</h1>
      <p>We've restricted your account because of unusual activity.</p>
    </main>`,
  ),

  // Renders successfully but matches nothing the detector knows.
  'unknown-page': shell(
    'Something Else | Mock LinkedIn',
    `<main><h1>An unfamiliar page</h1><p>No recognisable markers.</p></main>`,
  ),

  // A CAPTCHA container that is present in the DOM but hidden. Must NOT halt
  // the worker: a stray hidden node should not stop a whole run.
  'profile-hidden-captcha': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      topCard({ name: 'Jane Doe', degree: '2nd', buttons: CONNECT_BUTTON }) +
      `<div class="captcha-container" style="display:none">
         <iframe src="about:blank" title="captcha" width="300" height="200"></iframe>
       </div>`,
  ),

  // A visible CAPTCHA overlaying an otherwise normal profile. Must halt.
  'profile-captcha-overlay': shell(
    'Jane Doe | LinkedIn',
    GLOBAL_NAV +
      topCard({ name: 'Jane Doe', degree: '2nd', buttons: CONNECT_BUTTON }) +
      `<div class="captcha-container">
         <iframe src="about:blank" title="captcha" width="300" height="200"></iframe>
       </div>`,
  ),
};

/** Maps a profile slug to the fixture the mock server should serve for it. */
export const SLUG_FIXTURES: Record<string, FixtureName> = {
  'connect-available': 'profile-connect-available',
  'already-connected': 'profile-already-connected',
  'invitation-pending': 'profile-invitation-pending',
  'no-affordance': 'profile-no-affordance',
  'not-found': 'profile-not-found',
  // Slug names deliberately avoid the words a URL rule matches on, so these
  // exercise DOM detection rather than passing via the URL pattern.
  'security-wall-dom': 'captcha',
  'verify-step-dom': 'security-challenge',
  'flagged-account-dom': 'account-restricted',
  'weird-page': 'unknown-page',
  'needs-login': 'login-required',
  'connect-flow': 'profile-connect-then-pending',
  'connect-email-gate': 'profile-connect-email-required',
  'connect-no-note': 'profile-connect-no-note-field',
  'hidden-challenge-markup': 'profile-hidden-captcha',
  'visible-challenge-overlay': 'profile-captcha-overlay',
};
