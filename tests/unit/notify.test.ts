import { describe, expect, it, vi } from 'vitest';

import { formatAlert, notify } from '@/lib/notify';

/**
 * Operator alerting.
 *
 * This code sits on the incident path, which is itself the failure path. The
 * property that matters more than delivery: it must be incapable of turning an
 * alerting problem into an incident-reporting problem.
 */

describe('formatAlert', () => {
  it('leads with severity and title, then the detail', () => {
    const text = formatAlert({
      severity: 'critical',
      title: 'Automation halted: CAPTCHA',
      detail: 'LinkedIn presented a CAPTCHA.',
    });
    expect(text).toContain('🚨');
    expect(text).toContain('Automation halted: CAPTCHA');
    expect(text).toContain('LinkedIn presented a CAPTCHA.');
  });

  it('renders fields, skipping ones with no value', () => {
    const text = formatAlert({
      severity: 'warning',
      title: 'T',
      detail: 'D',
      fields: { Type: 'CAPTCHA', 'Page state': undefined, Empty: '', Count: 0 },
    });
    expect(text).toContain('• Type: CAPTCHA');
    expect(text).not.toContain('Page state');
    expect(text).not.toContain('Empty');
    // 0 is a real value and must survive; only null/undefined/'' are dropped.
    expect(text).toContain('• Count: 0');
  });

  it('appends a link to the incidents page so the reader can act', () => {
    const text = formatAlert(
      { severity: 'info', title: 'T', detail: 'D' },
      'https://example.vercel.app/',
    );
    expect(text).toContain('https://example.vercel.app/incidents');
  });
});

describe('notify', () => {
  const alert = { severity: 'critical' as const, title: 'T', detail: 'D' };

  it('is a no-op when no webhook is configured, and says so distinctly', async () => {
    const result = await notify(alert, { webhookUrl: null });
    // Not "failed to deliver" — alerting is optional, and absence must not read
    // as a delivery failure in the logs.
    expect(result).toMatchObject({ attempted: false, delivered: false });
  });

  it('posts the alert text to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await notify(alert, {
      webhookUrl: 'https://hooks.example.com/x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.delivered).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.com/x');
    const body = JSON.parse((init as RequestInit).body as string);
    // Slack reads `text`, Discord reads `content`; one payload serves both.
    expect(body.text).toContain('T');
    expect(body.content).toBe(body.text);
  });

  it('reports a non-2xx response as undelivered rather than throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await notify(alert, {
      webhookUrl: 'https://hooks.example.com/x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ attempted: true, delivered: false });
    expect(result.reason).toContain('500');
  });

  it('swallows a network failure — the caller is already handling an incident', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      notify(alert, {
        webhookUrl: 'https://hooks.example.com/x',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ attempted: true, delivered: false, reason: 'ECONNREFUSED' });
  });

  it('passes an abort signal so a hanging webhook cannot stall incident handling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await notify(alert, {
      webhookUrl: 'https://hooks.example.com/x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
