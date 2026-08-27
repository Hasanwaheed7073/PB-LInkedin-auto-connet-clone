/**
 * Connection-note template rendering.
 *
 * Rules that matter for correctness:
 *  - Only the four documented variables are substituted. An unknown `{{...}}`
 *    is a template authoring error, not something to quietly delete.
 *  - A variable that resolves to nothing is reported, never rendered as an
 *    empty string. "Hi , I came across your profile" must be impossible.
 *  - Rendering is pure and deterministic. No model is involved, and nothing
 *    here invents claims about the sender or the recipient.
 */

export const TEMPLATE_VARIABLES = ['firstName', 'lastName', 'company', 'jobTitle'] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface TemplateContext {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface TemplateBodyIssues {
  /** Variables referenced by the template, in first-appearance order. */
  used: TemplateVariable[];
  /** `{{...}}` placeholders that are not supported variables. */
  unknown: string[];
}

export function inspectTemplateBody(body: string): TemplateBodyIssues {
  const used: TemplateVariable[] = [];
  const unknown: string[] = [];

  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]!;
    if ((TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      const typed = name as TemplateVariable;
      if (!used.includes(typed)) used.push(typed);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  return { used, unknown };
}

export type RenderResult =
  | { ok: true; text: string; usedVariables: TemplateVariable[] }
  | { ok: false; reason: 'UNKNOWN_VARIABLES'; unknown: string[] }
  | { ok: false; reason: 'MISSING_VALUES'; missing: TemplateVariable[] }
  | { ok: false; reason: 'TOO_LONG'; length: number; limit: number }
  | { ok: false; reason: 'EMPTY_RESULT' };

export interface RenderOptions {
  /**
   * Maximum rendered length. LinkedIn's own connection-note limit has changed
   * over time and differs by account type, so the ceiling is configuration
   * (`MAX_CONNECTION_NOTE_CHARS`) rather than a hardcoded assumption.
   */
  maxLength: number;
}

/**
 * Substitute a template against one lead.
 *
 * Every failure mode is explicit, so a caller can decide between skipping the
 * lead and surfacing an authoring error - and can never accidentally send a
 * half-rendered note.
 */
export function renderTemplate(
  body: string,
  context: TemplateContext,
  options: RenderOptions,
): RenderResult {
  const { used, unknown } = inspectTemplateBody(body);
  if (unknown.length > 0) {
    return { ok: false, reason: 'UNKNOWN_VARIABLES', unknown };
  }

  const values: Record<TemplateVariable, string> = {
    firstName: (context.firstName ?? '').trim(),
    lastName: (context.lastName ?? '').trim(),
    company: (context.company ?? '').trim(),
    jobTitle: (context.jobTitle ?? '').trim(),
  };

  const missing = used.filter((name) => values[name].length === 0);
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_VALUES', missing };
  }

  const text = body
    .replace(VARIABLE_PATTERN, (_full, name: string) => values[name as TemplateVariable])
    // Collapse the whitespace an author left around a placeholder, but keep
    // intentional paragraph breaks.
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();

  if (text.length === 0) return { ok: false, reason: 'EMPTY_RESULT' };
  if (text.length > options.maxLength) {
    return { ok: false, reason: 'TOO_LONG', length: text.length, limit: options.maxLength };
  }

  return { ok: true, text, usedVariables: used };
}

/** Human-readable explanation of a failed render, for the UI and the activity log. */
export function describeRenderFailure(result: Extract<RenderResult, { ok: false }>): string {
  switch (result.reason) {
    case 'UNKNOWN_VARIABLES':
      return `Template uses unsupported variable(s): ${result.unknown
        .map((u) => `{{${u}}}`)
        .join(', ')}. Supported: ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`;
    case 'MISSING_VALUES':
      return `This lead has no value for ${result.missing
        .map((m) => `{{${m}}}`)
        .join(', ')}, so the note would render incomplete.`;
    case 'TOO_LONG':
      return `Rendered note is ${result.length} characters, over the ${result.limit}-character limit.`;
    case 'EMPTY_RESULT':
      return 'Rendered note is empty.';
  }
}

/**
 * Longest possible rendered length given the leads a campaign will actually
 * target, so the operator finds out at activation time rather than mid-run that
 * some notes will be rejected for length.
 */
export function worstCaseRenderedLength(
  body: string,
  contexts: TemplateContext[],
  options: RenderOptions,
): { longest: number; offendingCount: number } {
  let longest = 0;
  let offendingCount = 0;
  for (const context of contexts) {
    const result = renderTemplate(body, context, { maxLength: Number.MAX_SAFE_INTEGER });
    if (result.ok) {
      longest = Math.max(longest, result.text.length);
      if (result.text.length > options.maxLength) offendingCount += 1;
    }
  }
  return { longest, offendingCount };
}
