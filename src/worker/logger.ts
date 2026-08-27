/**
 * Worker logging.
 *
 * Structured, line-oriented, and deliberately small - the worker runs in a
 * terminal the operator watches, so readability matters more than features.
 *
 * Requirement 21: cookies, tokens and session data must never be logged. Every
 * value passes through `scrub` before it is printed, so an accidental
 * `log.info('...', { headers })` cannot leak a session cookie into a terminal
 * scrollback or a log file.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /(cookie|token|password|secret|authorization|auth|session|li_at|jsessionid|bearer|credential|apikey)/i;

/** Long opaque strings that look like credentials, redacted on sight. */
const SENSITIVE_VALUE = /^(?:[A-Za-z0-9_\-]{40,}|AQ[A-Za-z0-9_\-]{20,})$/;

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return '[redacted]';
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };

  if (Array.isArray(value)) return value.slice(0, 30).map((v) => scrub(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(raw, depth + 1);
    }
    return out;
  }

  return String(value);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const PREFIX: Record<Level, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function format(
  level: Level,
  message: string,
  bindings: Record<string, unknown>,
  context?: Record<string, unknown>,
): string {
  const merged = { ...bindings, ...(context ?? {}) };
  const scrubbed = scrub(merged) as Record<string, unknown>;
  const parts = Object.entries(scrubbed)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const suffix = parts.length > 0 ? `  ${parts.join(' ')}` : '';
  return `${timestamp()} ${PREFIX[level]} ${message}${suffix}`;
}

export function createLogger(
  bindings: Record<string, unknown> = {},
  minLevel: Level = (process.env.WORKER_LOG_LEVEL as Level) || 'info',
): Logger {
  const threshold = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;

  const emit = (level: Level, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = format(level, message, bindings, context);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) => createLogger({ ...bindings, ...extra }, minLevel),
  };
}
