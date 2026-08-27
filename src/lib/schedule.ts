import { DateTime, IANAZone } from 'luxon';

/**
 * Scheduling arithmetic.
 *
 * Pure functions only - no database access, no side effects, fully unit
 * testable, and every function takes `now` explicitly so tests never depend on
 * the wall clock.
 *
 * All operating-hour maths happens in the campaign's own IANA timezone, which
 * is what makes "09:00-17:00, Mon-Fri" behave correctly across DST boundaries.
 */

export interface ScheduleConfig {
  timezone: string;
  /** Minutes from local midnight. */
  windowStartMinute: number;
  windowEndMinute: number;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  operatingDays: number[];
  dailyLimit: number;
  minActionDelaySeconds: number;
  maxActionDelaySeconds: number;
}

export function isValidTimezone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/** Fall back to UTC rather than throwing, so a bad stored zone cannot brick the scheduler. */
function zoneOf(config: ScheduleConfig): string {
  return isValidTimezone(config.timezone) ? config.timezone : 'UTC';
}

/**
 * A window whose end is at or before its start wraps past midnight
 * (e.g. 22:00-02:00). Handled explicitly because the naive comparison silently
 * yields "never open".
 */
export function isOvernightWindow(config: ScheduleConfig): boolean {
  return config.windowEndMinute <= config.windowStartMinute;
}

/**
 * UTC instants bounding the local calendar day that `at` falls in. Used for
 * daily-limit counting, so "today" means today where the operator is, not UTC.
 */
export function localDayBounds(timezone: string, at: Date): { start: Date; end: Date } {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const local = DateTime.fromJSDate(at, { zone });
  return {
    start: local.startOf('day').toJSDate(),
    end: local.startOf('day').plus({ days: 1 }).toJSDate(),
  };
}

/** `2026-08-26` in the campaign timezone - the key daily counters are grouped by. */
export function localDayKey(timezone: string, at: Date): string {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  return DateTime.fromJSDate(at, { zone }).toISODate() ?? 'unknown';
}

function minutesSinceLocalMidnight(dt: DateTime): number {
  return dt.hour * 60 + dt.minute + dt.second / 60;
}

/**
 * Is `at` inside the configured operating window?
 *
 * For an overnight window the day check applies to the day the window *opened*,
 * so a Friday 22:00-02:00 window stays open into Saturday morning.
 */
export function isWithinOperatingWindow(config: ScheduleConfig, at: Date): boolean {
  const zone = zoneOf(config);
  const local = DateTime.fromJSDate(at, { zone });
  const minutes = minutesSinceLocalMidnight(local);
  const days = new Set(config.operatingDays);

  if (days.size === 0) return false;

  if (!isOvernightWindow(config)) {
    return (
      days.has(local.weekday) &&
      minutes >= config.windowStartMinute &&
      minutes < config.windowEndMinute
    );
  }

  // Overnight: either the tail of today's window, or the head that opened yesterday.
  if (minutes >= config.windowStartMinute) {
    return days.has(local.weekday);
  }
  if (minutes < config.windowEndMinute) {
    const yesterday = local.minus({ days: 1 });
    return days.has(yesterday.weekday);
  }
  return false;
}

/**
 * Next instant at which the window is open, at or after `at`.
 * Returns `null` when `operatingDays` is empty (the window never opens).
 */
export function nextWindowOpen(config: ScheduleConfig, at: Date): Date | null {
  if (new Set(config.operatingDays).size === 0) return null;
  if (isWithinOperatingWindow(config, at)) return at;

  const zone = zoneOf(config);
  const local = DateTime.fromJSDate(at, { zone });
  const days = new Set(config.operatingDays);

  // Scan a fortnight of candidate openings; enough to cover any weekday pattern.
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = local.plus({ days: offset }).startOf('day');
    if (!days.has(day.weekday)) continue;

    const opening = day.plus({ minutes: config.windowStartMinute });
    if (opening.toMillis() >= at.getTime()) {
      return opening.toJSDate();
    }
  }
  return null;
}

/** End of the window instance currently open, or `null` if it is not open. */
export function currentWindowClose(config: ScheduleConfig, at: Date): Date | null {
  if (!isWithinOperatingWindow(config, at)) return null;
  const zone = zoneOf(config);
  const local = DateTime.fromJSDate(at, { zone });
  const minutes = minutesSinceLocalMidnight(local);

  if (!isOvernightWindow(config)) {
    return local.startOf('day').plus({ minutes: config.windowEndMinute }).toJSDate();
  }
  // Overnight window: the close is tomorrow morning if we are past the opening.
  if (minutes >= config.windowStartMinute) {
    return local.startOf('day').plus({ days: 1, minutes: config.windowEndMinute }).toJSDate();
  }
  return local.startOf('day').plus({ minutes: config.windowEndMinute }).toJSDate();
}

export type EligibilityReason =
  | 'ELIGIBLE'
  | 'OUTSIDE_OPERATING_HOURS'
  | 'DAILY_LIMIT_REACHED'
  | 'GLOBAL_DAILY_LIMIT_REACHED'
  | 'NO_OPERATING_DAYS'
  | 'NOT_YET_SCHEDULED';

export interface EligibilityInput {
  config: ScheduleConfig;
  now: Date;
  /** Outreach actions already performed by this campaign in its local day. */
  actionsToday: number;
  /** Outreach actions performed across every campaign in this local day. */
  globalActionsToday: number;
  globalDailyLimit: number;
  /** Earliest `scheduledFor` among waiting jobs, if any. */
  earliestScheduledFor?: Date | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** When this campaign could next run, if that is knowable. */
  nextEligibleAt: Date | null;
  remainingToday: number;
}

/**
 * Decide whether a campaign may run right now.
 *
 * Deliberately conservative: every limit is a floor, and any doubt resolves to
 * "not eligible". This is the only gate between the queue and real outreach, so
 * it never rounds in favour of sending.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { config, now, actionsToday, globalActionsToday, globalDailyLimit } = input;

  const campaignRemaining = Math.max(0, config.dailyLimit - actionsToday);
  const globalRemaining = Math.max(0, globalDailyLimit - globalActionsToday);
  const remainingToday = Math.min(campaignRemaining, globalRemaining);

  if (new Set(config.operatingDays).size === 0) {
    return {
      eligible: false,
      reason: 'NO_OPERATING_DAYS',
      nextEligibleAt: null,
      remainingToday,
    };
  }

  if (!isWithinOperatingWindow(config, now)) {
    return {
      eligible: false,
      reason: 'OUTSIDE_OPERATING_HOURS',
      nextEligibleAt: nextWindowOpen(config, now),
      remainingToday,
    };
  }

  // Both daily counters reset at the start of the next local day; if the window
  // is open across that boundary the campaign resumes then, otherwise at the
  // next opening.
  const tomorrowStart = localDayBounds(zoneOf(config), now).end;
  const resumeAfterReset = nextWindowOpen(config, tomorrowStart);

  if (globalRemaining <= 0) {
    return {
      eligible: false,
      reason: 'GLOBAL_DAILY_LIMIT_REACHED',
      nextEligibleAt: resumeAfterReset,
      remainingToday: 0,
    };
  }

  if (campaignRemaining <= 0) {
    return {
      eligible: false,
      reason: 'DAILY_LIMIT_REACHED',
      nextEligibleAt: resumeAfterReset,
      remainingToday: 0,
    };
  }

  const earliest = input.earliestScheduledFor;
  if (earliest && earliest.getTime() > now.getTime()) {
    return {
      eligible: false,
      reason: 'NOT_YET_SCHEDULED',
      nextEligibleAt: earliest,
      remainingToday,
    };
  }

  return { eligible: true, reason: 'ELIGIBLE', nextEligibleAt: now, remainingToday };
}

export const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  ELIGIBLE: 'Eligible to run',
  OUTSIDE_OPERATING_HOURS: 'Outside configured operating hours',
  DAILY_LIMIT_REACHED: 'Campaign daily limit reached',
  GLOBAL_DAILY_LIMIT_REACHED: 'Global daily action limit reached',
  NO_OPERATING_DAYS: 'No operating days configured - campaign can never run',
  NOT_YET_SCHEDULED: 'Next job is scheduled for later',
};

/**
 * Spread `count` jobs across the operating window starting at `from`.
 *
 * Spacing comes from the campaign's configured min/max delay. This exists to
 * keep a campaign comfortably inside its own configured limit and to spread
 * load across the day - it is not an evasion or "look human" mechanism, and the
 * jitter is derived from a caller-supplied deterministic sequence so schedules
 * are reproducible and testable.
 */
export function buildSchedule(
  config: ScheduleConfig,
  from: Date,
  count: number,
  jitter: (index: number) => number = () => 0.5,
): Date[] {
  if (count <= 0) return [];

  const minDelay = Math.max(1, config.minActionDelaySeconds);
  const maxDelay = Math.max(minDelay, config.maxActionDelaySeconds);

  // A campaign whose window can never open must produce no schedule at all.
  // Falling back to `from` here would queue jobs for a campaign that can never
  // legitimately run them.
  const firstOpening = nextWindowOpen(config, from);
  if (!firstOpening) return [];

  const schedule: Date[] = [];
  let cursor = firstOpening;
  let remainingInDay = config.dailyLimit;

  for (let i = 0; i < count; i += 1) {
    if (remainingInDay <= 0) {
      // Daily allowance exhausted - jump to the next window after the local day rolls over.
      const nextDay = localDayBounds(zoneOf(config), cursor).end;
      const reopen = nextWindowOpen(config, nextDay);
      if (!reopen) break;
      cursor = reopen;
      remainingInDay = config.dailyLimit;
    }

    const close = currentWindowClose(config, cursor);
    if (close && cursor.getTime() >= close.getTime()) {
      const reopen = nextWindowOpen(config, close);
      if (!reopen) break;
      cursor = reopen;
      remainingInDay = config.dailyLimit;
      continue;
    }

    schedule.push(cursor);
    remainingInDay -= 1;

    const factor = Math.min(1, Math.max(0, jitter(i)));
    const gapSeconds = Math.round(minDelay + (maxDelay - minDelay) * factor);
    let next = new Date(cursor.getTime() + gapSeconds * 1000);

    const windowClose = currentWindowClose(config, cursor);
    if (windowClose && next.getTime() >= windowClose.getTime()) {
      const reopen = nextWindowOpen(config, windowClose);
      if (!reopen) break;
      next = reopen;
      remainingInDay = config.dailyLimit;
    }
    cursor = next;
  }

  return schedule;
}

/**
 * Exponential backoff for TECHNICAL failures only.
 *
 * Never applied to CAPTCHA, security challenges, restrictions or login
 * failures - those must reach a human, and retrying them is actively harmful.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; jitter?: number } = {},
): number {
  const baseMs = options.baseMs ?? 30_000;
  const maxMs = options.maxMs ?? 30 * 60_000;
  const jitter = options.jitter ?? 0.5;

  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, exponential);
  // Full jitter in [capped/2, capped] keeps repeated failures from re-firing in lockstep.
  const factor = 0.5 + 0.5 * Math.min(1, Math.max(0, jitter));
  return Math.round(capped * factor);
}
