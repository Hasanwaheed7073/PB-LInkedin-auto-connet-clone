/**
 * Operator alerting.
 *
 * The point of this module is a single scenario: the worker halts at 03:00 on a
 * CAPTCHA, and nobody is watching a terminal. Without an alert the campaign is
 * silently stopped until somebody happens to open the dashboard, which in
 * practice means days. An unattended worker with no alerting is worse than a
 * supervised one, because it looks like it is working.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Never break the caller.** Alerting sits on the incident path, which is
 *    itself the failure path. A notifier that throws would turn "LinkedIn asked
 *    for a CAPTCHA" into "the worker crashed while reporting a CAPTCHA".
 *    Every failure here is caught and logged, never propagated.
 * 2. **Never block.** Delivery is fire-and-forget with a short timeout, so a
 *    slow webhook cannot stall incident handling.
 * 3. **Say what to do.** An alert that only says "incident" makes the reader
 *    open a laptop to find out whether it matters. The severity, the reason and
 *    the link belong in the message.
 * 4. **No secrets in the payload.** These messages travel to a third-party chat
 *    service and are read on phones.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Where the operator should go to act on this. */
  url?: string | null;
  /** Short labelled facts, rendered as a list. Keep out anything sensitive. */
  fields?: Record<string, string | number | null | undefined>;
}

export interface NotifyResult {
  attempted: boolean;
  delivered: boolean;
  reason?: string;
}

const TIMEOUT_MS = 8_000;

const EMOJI: Record<AlertSeverity, string> = {
  critical: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
};

/**
 * Render as plain text. Slack, Discord and Teams all accept a `text` field, and
 * plain text degrades correctly in a generic webhook receiver or an email
 * relay, which a Slack-specific block payload does not.
 */
export function formatAlert(alert: Alert, baseUrl?: string | null): string {
  const lines = [`${EMOJI[alert.severity]} *${alert.title}*`, alert.detail];

  for (const [key, value] of Object.entries(alert.fields ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`• ${key}: ${value}`);
  }

  const link = alert.url ?? (baseUrl ? `${baseUrl.replace(/\/$/, '')}/incidents` : null);
  if (link) lines.push(link);

  return lines.join('\n');
}

/**
 * Send an alert to the configured webhook.
 *
 * Returns rather than throws, so a caller can log the outcome without needing a
 * try/catch of its own. With no webhook configured this is a no-op reporting
 * `attempted: false` — alerting is optional, and its absence must not look like
 * a delivery failure.
 */
export async function notify(
  alert: Alert,
  options: { webhookUrl?: string | null; baseUrl?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<NotifyResult> {
  const webhookUrl = options.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? null;
  if (!webhookUrl) return { attempted: false, delivered: false, reason: 'No ALERT_WEBHOOK_URL set' };

  const baseUrl = options.baseUrl ?? process.env.DASHBOARD_BASE_URL ?? null;
  const doFetch = options.fetchImpl ?? fetch;
  const text = formatAlert(alert, baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `text` is what Slack and Discord read; `content` is Discord's own name
      // for it. Sending both means one payload works with either.
      body: JSON.stringify({ text, content: text, severity: alert.severity }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { attempted: true, delivered: false, reason: `webhook returned HTTP ${res.status}` };
    }
    return { attempted: true, delivered: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { attempted: true, delivered: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
