import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return NUMBER_FORMAT.format(value);
}

/** Absolute timestamp, minute precision - matches the activity-log format in the spec. */
export function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatRelativeTime(value: Date | string | null | undefined): string {
  if (!value) return 'never';
  const date = typeof value === 'string' ? new Date(value) : value;
  const deltaMs = Date.now() - date.getTime();
  const future = deltaMs < 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  const render = (n: number, unit: string) =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;

  if (seconds < 10) return future ? 'in a moment' : 'just now';
  if (seconds < 60) return render(seconds, 's');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return render(minutes, 'm');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return render(hours, 'h');
  const days = Math.floor(hours / 24);
  if (days < 30) return render(days, 'd');
  return formatTimestamp(date);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** `540` -> `09:00`. Operating-hour windows are stored as minutes from local midnight. */
export function minutesToClock(minutes: number): string {
  const safe = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `09:00` -> `540`. Returns null when unparseable, so callers can surface a field error. */
export function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  const total = h * 60 + m;
  return total > 24 * 60 ? null : total;
}

const ISO_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** ISO weekdays (1 = Monday) rendered compactly, e.g. `Mon-Fri` or `Mon, Wed, Fri`. */
export function formatOperatingDays(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 0) return 'never';
  if (sorted.length === 7) return 'every day';

  const isContiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (isContiguous && sorted.length > 2) {
    return `${ISO_WEEKDAY_LABELS[sorted[0]! - 1]}-${ISO_WEEKDAY_LABELS[sorted[sorted.length - 1]! - 1]}`;
  }
  return sorted.map((d) => ISO_WEEKDAY_LABELS[d - 1]).join(', ');
}

/** Human-readable label for any SCREAMING_SNAKE enum value. */
export function humanizeEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Deterministic clamp used by the scheduler and retry maths. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
