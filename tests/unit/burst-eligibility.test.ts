import { describe, expect, it } from 'vitest';

import { evaluateEligibility, type ScheduleConfig } from '@/lib/schedule';

/**
 * A burst is an operator saying "send these now", so it may run outside the
 * campaign's operating hours. What it must never do is lift a daily ceiling:
 * the window is a preference, the ceilings protect the account.
 */

const WEEKDAYS_9_TO_5: ScheduleConfig = {
  timezone: 'UTC',
  windowStartMinute: 9 * 60,
  windowEndMinute: 17 * 60,
  operatingDays: [1, 2, 3, 4, 5],
  dailyLimit: 15,
  minActionDelaySeconds: 60,
  maxActionDelaySeconds: 120,
};

// A Sunday, 03:00 UTC — outside both the window and the operating days.
const SUNDAY_NIGHT = new Date('2026-08-30T03:00:00.000Z');

const base = {
  config: WEEKDAYS_9_TO_5,
  now: SUNDAY_NIGHT,
  actionsToday: 0,
  globalActionsToday: 0,
  globalDailyLimit: 40,
};

describe('burst override', () => {
  it('refuses outside operating hours when no burst is active', () => {
    const result = evaluateEligibility(base);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('OUTSIDE_OPERATING_HOURS');
  });

  it('allows a run outside operating hours while a burst is live', () => {
    const result = evaluateEligibility({
      ...base,
      burstUntil: new Date(SUNDAY_NIGHT.getTime() + 30 * 60_000),
    });
    expect(result.eligible).toBe(true);
  });

  it('stops allowing it once the burst has expired', () => {
    const result = evaluateEligibility({
      ...base,
      burstUntil: new Date(SUNDAY_NIGHT.getTime() - 60_000),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('OUTSIDE_OPERATING_HOURS');
  });

  it('still enforces the campaign daily limit during a burst', () => {
    const result = evaluateEligibility({
      ...base,
      actionsToday: 15,
      burstUntil: new Date(SUNDAY_NIGHT.getTime() + 30 * 60_000),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('DAILY_LIMIT_REACHED');
    expect(result.remainingToday).toBe(0);
  });

  it('still enforces the global ceiling during a burst', () => {
    const result = evaluateEligibility({
      ...base,
      globalActionsToday: 40,
      burstUntil: new Date(SUNDAY_NIGHT.getTime() + 30 * 60_000),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('GLOBAL_DAILY_LIMIT_REACHED');
  });

  it('overrides an empty operating-days list too, since both describe timing', () => {
    // Deliberate: "no operating days" and "outside the window" are the same
    // kind of statement - when the campaign would normally run - and a burst
    // overrides that by design. The ceilings above are what it cannot touch.
    const result = evaluateEligibility({
      ...base,
      config: { ...WEEKDAYS_9_TO_5, operatingDays: [] },
      burstUntil: new Date(SUNDAY_NIGHT.getTime() + 30 * 60_000),
    });
    expect(result.eligible).toBe(true);

    // ...and with no burst, the same campaign is refused.
    expect(
      evaluateEligibility({ ...base, config: { ...WEEKDAYS_9_TO_5, operatingDays: [] } }).reason,
    ).toBe('NO_OPERATING_DAYS');
  });
});
