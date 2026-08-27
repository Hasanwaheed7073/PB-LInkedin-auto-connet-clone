import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  buildSchedule,
  currentWindowClose,
  evaluateEligibility,
  isOvernightWindow,
  isValidTimezone,
  isWithinOperatingWindow,
  localDayBounds,
  localDayKey,
  nextWindowOpen,
  type ScheduleConfig,
} from '@/lib/schedule';

/**
 * Scheduling.
 *
 * Every case passes `now` explicitly, so nothing here depends on the wall clock
 * or the machine's timezone. The interesting cases are the ones that would let
 * outreach happen when the operator did not intend it: outside hours, over the
 * daily limit, or across a DST boundary.
 */

const base: ScheduleConfig = {
  timezone: 'Europe/Berlin',
  windowStartMinute: 9 * 60, // 09:00
  windowEndMinute: 17 * 60, // 17:00
  operatingDays: [1, 2, 3, 4, 5],
  dailyLimit: 20,
  minActionDelaySeconds: 60,
  maxActionDelaySeconds: 120,
};

/** Wednesday 2026-08-26. Berlin is UTC+2 in August. */
const wedNoonBerlin = new Date('2026-08-26T10:00:00Z'); // 12:00 Berlin
const wedEarlyBerlin = new Date('2026-08-26T05:00:00Z'); // 07:00 Berlin
const wedLateBerlin = new Date('2026-08-26T18:00:00Z'); // 20:00 Berlin
const satNoonBerlin = new Date('2026-08-29T10:00:00Z'); // Saturday 12:00 Berlin

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects nonsense', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('CET+2')).toBe(false);
  });
});

describe('isWithinOperatingWindow', () => {
  it('is open inside the window on an operating day', () => {
    expect(isWithinOperatingWindow(base, wedNoonBerlin)).toBe(true);
  });

  it('is closed before the window opens', () => {
    expect(isWithinOperatingWindow(base, wedEarlyBerlin)).toBe(false);
  });

  it('is closed after the window ends', () => {
    expect(isWithinOperatingWindow(base, wedLateBerlin)).toBe(false);
  });

  it('is closed on a non-operating day even at midday', () => {
    expect(isWithinOperatingWindow(base, satNoonBerlin)).toBe(false);
  });

  it('is closed when no operating days are configured', () => {
    expect(isWithinOperatingWindow({ ...base, operatingDays: [] }, wedNoonBerlin)).toBe(false);
  });

  it('interprets the window in the campaign timezone, not UTC', () => {
    // 08:00 UTC is 10:00 Berlin (inside) but 08:00 UTC itself is outside a
    // 09:00-17:00 UTC window - so a UTC-based implementation would disagree.
    const at = new Date('2026-08-26T08:00:00Z');
    expect(isWithinOperatingWindow(base, at)).toBe(true);
    expect(isWithinOperatingWindow({ ...base, timezone: 'UTC' }, at)).toBe(false);
  });

  it('respects the boundaries: open at start, closed at end', () => {
    expect(isWithinOperatingWindow(base, new Date('2026-08-26T07:00:00Z'))).toBe(true); // 09:00
    expect(isWithinOperatingWindow(base, new Date('2026-08-26T15:00:00Z'))).toBe(false); // 17:00
  });

  it('falls back to UTC for an invalid stored timezone rather than throwing', () => {
    const config = { ...base, timezone: 'Not/AZone' };
    expect(() => isWithinOperatingWindow(config, wedNoonBerlin)).not.toThrow();
  });
});

describe('overnight windows', () => {
  const overnight: ScheduleConfig = {
    ...base,
    windowStartMinute: 22 * 60, // 22:00
    windowEndMinute: 2 * 60, // 02:00
  };

  it('is recognised as overnight', () => {
    expect(isOvernightWindow(overnight)).toBe(true);
    expect(isOvernightWindow(base)).toBe(false);
  });

  it('is open late on an operating day', () => {
    // Wednesday 23:00 Berlin
    expect(isWithinOperatingWindow(overnight, new Date('2026-08-26T21:00:00Z'))).toBe(true);
  });

  it('stays open into the following morning', () => {
    // Thursday 01:00 Berlin - the window opened on Wednesday
    expect(isWithinOperatingWindow(overnight, new Date('2026-08-26T23:00:00Z'))).toBe(true);
  });

  it('is closed in the middle of the day', () => {
    expect(isWithinOperatingWindow(overnight, wedNoonBerlin)).toBe(false);
  });

  it('is open Saturday 01:00 because the window opened on Friday', () => {
    // Saturday 01:00 Berlin = Friday's window still running
    expect(isWithinOperatingWindow(overnight, new Date('2026-08-28T23:00:00Z'))).toBe(true);
  });

  it('is closed Sunday 01:00 because Saturday is not an operating day', () => {
    expect(isWithinOperatingWindow(overnight, new Date('2026-08-29T23:00:00Z'))).toBe(false);
  });
});

describe('nextWindowOpen', () => {
  it('returns now when the window is already open', () => {
    expect(nextWindowOpen(base, wedNoonBerlin)?.getTime()).toBe(wedNoonBerlin.getTime());
  });

  it('returns this morning when called before opening', () => {
    const next = nextWindowOpen(base, wedEarlyBerlin);
    // 09:00 Berlin == 07:00 UTC
    expect(next?.toISOString()).toBe('2026-08-26T07:00:00.000Z');
  });

  it('skips to the next day when called after closing', () => {
    const next = nextWindowOpen(base, wedLateBerlin);
    expect(next?.toISOString()).toBe('2026-08-27T07:00:00.000Z');
  });

  it('skips the weekend', () => {
    // Friday 20:00 Berlin -> Monday 09:00 Berlin
    const next = nextWindowOpen(base, new Date('2026-08-28T18:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-31T07:00:00.000Z');
  });

  it('returns null when the campaign can never run', () => {
    expect(nextWindowOpen({ ...base, operatingDays: [] }, wedNoonBerlin)).toBeNull();
  });

  it('handles the DST boundary, keeping the local wall-clock opening time', () => {
    // Europe/Berlin leaves DST on 2026-10-25. A window at 09:00 local must still
    // be 09:00 local afterwards, which is a different UTC instant (08:00Z, not 07:00Z).
    const beforeDst = nextWindowOpen(base, new Date('2026-10-22T18:00:00Z'));
    const afterDst = nextWindowOpen(base, new Date('2026-10-27T18:00:00Z'));
    expect(beforeDst?.toISOString()).toBe('2026-10-23T07:00:00.000Z');
    expect(afterDst?.toISOString()).toBe('2026-10-28T08:00:00.000Z');
  });
});

describe('currentWindowClose', () => {
  it('returns the closing instant while open', () => {
    expect(currentWindowClose(base, wedNoonBerlin)?.toISOString()).toBe(
      '2026-08-26T15:00:00.000Z',
    );
  });

  it('returns null while closed', () => {
    expect(currentWindowClose(base, wedLateBerlin)).toBeNull();
  });
});

describe('localDayBounds and localDayKey', () => {
  it('bounds the local calendar day, not the UTC one', () => {
    // 00:30 Berlin on the 27th is 22:30 UTC on the 26th.
    const { start, end } = localDayBounds('Europe/Berlin', new Date('2026-08-26T22:30:00Z'));
    expect(start.toISOString()).toBe('2026-08-26T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-27T22:00:00.000Z');
  });

  it('keys the day in the campaign timezone', () => {
    // 22:30 UTC on the 26th is already the 27th in Berlin.
    expect(localDayKey('Europe/Berlin', new Date('2026-08-26T22:30:00Z'))).toBe('2026-08-27');
    expect(localDayKey('UTC', new Date('2026-08-26T22:30:00Z'))).toBe('2026-08-26');
  });
});

describe('evaluateEligibility', () => {
  const ok = {
    config: base,
    now: wedNoonBerlin,
    actionsToday: 0,
    globalActionsToday: 0,
    globalDailyLimit: 40,
  };

  it('is eligible inside the window and under both limits', () => {
    const result = evaluateEligibility(ok);
    expect(result).toMatchObject({ eligible: true, reason: 'ELIGIBLE', remainingToday: 20 });
  });

  it('is ineligible outside operating hours', () => {
    const result = evaluateEligibility({ ...ok, now: wedLateBerlin });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('OUTSIDE_OPERATING_HOURS');
    expect(result.nextEligibleAt?.toISOString()).toBe('2026-08-27T07:00:00.000Z');
  });

  it('is ineligible at the campaign daily limit', () => {
    const result = evaluateEligibility({ ...ok, actionsToday: 20 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('DAILY_LIMIT_REACHED');
    expect(result.remainingToday).toBe(0);
  });

  it('is ineligible at the global daily limit even when the campaign has budget', () => {
    const result = evaluateEligibility({ ...ok, actionsToday: 1, globalActionsToday: 40 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('GLOBAL_DAILY_LIMIT_REACHED');
  });

  it('reports the lower of the two remaining budgets', () => {
    const result = evaluateEligibility({ ...ok, actionsToday: 5, globalActionsToday: 37 });
    // campaign has 15 left, global has 3 left
    expect(result.remainingToday).toBe(3);
  });

  it('is ineligible when the next job is scheduled for later', () => {
    const later = new Date(wedNoonBerlin.getTime() + 30 * 60_000);
    const result = evaluateEligibility({ ...ok, earliestScheduledFor: later });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NOT_YET_SCHEDULED');
    expect(result.nextEligibleAt?.getTime()).toBe(later.getTime());
  });

  it('is eligible when the next job was scheduled in the past', () => {
    const earlier = new Date(wedNoonBerlin.getTime() - 60_000);
    expect(evaluateEligibility({ ...ok, earliestScheduledFor: earlier }).eligible).toBe(true);
  });

  it('reports a campaign that can never run', () => {
    const result = evaluateEligibility({ ...ok, config: { ...base, operatingDays: [] } });
    expect(result.reason).toBe('NO_OPERATING_DAYS');
    expect(result.nextEligibleAt).toBeNull();
  });

  it('never reports a negative remaining budget', () => {
    const result = evaluateEligibility({ ...ok, actionsToday: 999 });
    expect(result.remainingToday).toBe(0);
  });
});

describe('buildSchedule', () => {
  // Deterministic jitter so the schedule is reproducible.
  const midJitter = () => 0.5;

  it('returns nothing for a zero count', () => {
    expect(buildSchedule(base, wedNoonBerlin, 0, midJitter)).toEqual([]);
  });

  it('starts at the window opening when called before hours', () => {
    const schedule = buildSchedule(base, wedEarlyBerlin, 3, midJitter);
    expect(schedule[0]?.toISOString()).toBe('2026-08-26T07:00:00.000Z');
  });

  it('spaces actions by the configured delay', () => {
    const schedule = buildSchedule(base, wedNoonBerlin, 3, midJitter);
    // min 60 + (120-60)*0.5 = 90 seconds
    expect(schedule[1]!.getTime() - schedule[0]!.getTime()).toBe(90_000);
    expect(schedule[2]!.getTime() - schedule[1]!.getTime()).toBe(90_000);
  });

  it('produces strictly increasing timestamps', () => {
    const schedule = buildSchedule(base, wedNoonBerlin, 40, midJitter);
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i]!.getTime()).toBeGreaterThan(schedule[i - 1]!.getTime());
    }
  });

  it('never schedules outside the operating window', () => {
    const schedule = buildSchedule(base, wedNoonBerlin, 100, midJitter);
    for (const at of schedule) {
      expect(isWithinOperatingWindow(base, at)).toBe(true);
    }
  });

  it('respects the daily limit, rolling over to the next operating day', () => {
    const config = { ...base, dailyLimit: 5 };
    const schedule = buildSchedule(config, wedEarlyBerlin, 12, midJitter);

    const perDay = new Map<string, number>();
    for (const at of schedule) {
      const key = localDayKey(config.timezone, at);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    for (const count of perDay.values()) {
      expect(count).toBeLessThanOrEqual(5);
    }
    expect(perDay.size).toBeGreaterThan(1);
  });

  it('skips the weekend when rolling over', () => {
    const config = { ...base, dailyLimit: 2 };
    // Friday 08:00 Berlin, 6 jobs -> Fri(2), Mon(2), Tue(2)
    const schedule = buildSchedule(config, new Date('2026-08-28T06:00:00Z'), 6, midJitter);
    const days = [...new Set(schedule.map((d) => localDayKey(config.timezone, d)))];
    expect(days).toEqual(['2026-08-28', '2026-08-31', '2026-09-01']);
  });

  it('returns nothing when the campaign can never run', () => {
    expect(buildSchedule({ ...base, operatingDays: [] }, wedNoonBerlin, 5, midJitter)).toEqual([]);
  });

  it('can schedule a full 600-lead list without gaps or duplicates', () => {
    const schedule = buildSchedule(base, wedEarlyBerlin, 600, midJitter);
    expect(schedule.length).toBeGreaterThan(0);
    expect(new Set(schedule.map((d) => d.getTime())).size).toBe(schedule.length);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    const a1 = backoffDelayMs(1, { jitter: 1 });
    const a2 = backoffDelayMs(2, { jitter: 1 });
    const a3 = backoffDelayMs(3, { jitter: 1 });
    expect(a1).toBe(30_000);
    expect(a2).toBe(60_000);
    expect(a3).toBe(120_000);
  });

  it('is capped', () => {
    expect(backoffDelayMs(50, { jitter: 1 })).toBe(30 * 60_000);
  });

  it('applies jitter within [half, full]', () => {
    const full = backoffDelayMs(3, { jitter: 1 });
    const none = backoffDelayMs(3, { jitter: 0 });
    expect(none).toBe(full / 2);
    expect(backoffDelayMs(3, { jitter: 0.5 })).toBeGreaterThanOrEqual(none);
    expect(backoffDelayMs(3, { jitter: 0.5 })).toBeLessThanOrEqual(full);
  });

  it('is always positive, even for attempt 0', () => {
    expect(backoffDelayMs(0, { jitter: 0 })).toBeGreaterThan(0);
  });
});
