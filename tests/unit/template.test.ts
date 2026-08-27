import { describe, expect, it } from 'vitest';

import {
  describeRenderFailure,
  inspectTemplateBody,
  renderTemplate,
  worstCaseRenderedLength,
} from '@/lib/template';

/**
 * Template rendering.
 *
 * The load-bearing property: a template must never render a note with a gap in
 * it. "Hi , I came across your profile" going out to a real person is the
 * failure mode these tests exist to prevent.
 */

const LIMIT = { maxLength: 280 };

describe('inspectTemplateBody', () => {
  it('lists the variables used, in first-appearance order, without duplicates', () => {
    const result = inspectTemplateBody('Hi {{firstName}}, you work at {{company}}, {{firstName}}?');
    expect(result.used).toEqual(['firstName', 'company']);
    expect(result.unknown).toEqual([]);
  });

  it('flags unsupported variables rather than ignoring them', () => {
    const result = inspectTemplateBody('Hi {{firstName}}, your {{industry}} and {{nonsense}}');
    expect(result.used).toEqual(['firstName']);
    expect(result.unknown).toEqual(['industry', 'nonsense']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(inspectTemplateBody('Hi {{ firstName }}').used).toEqual(['firstName']);
  });

  it('finds nothing in a template with no variables', () => {
    const result = inspectTemplateBody('Hello, it would be good to connect.');
    expect(result.used).toEqual([]);
    expect(result.unknown).toEqual([]);
  });
});

describe('renderTemplate', () => {
  const lead = {
    firstName: 'John',
    lastName: 'Smith',
    company: 'Acme Clinical',
    jobTitle: 'Clinical Research Associate',
  };

  it('substitutes every supported variable', () => {
    const result = renderTemplate(
      'Hi {{firstName}} {{lastName}}, {{jobTitle}} at {{company}} - worth connecting.',
      lead,
      LIMIT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(
        'Hi John Smith, Clinical Research Associate at Acme Clinical - worth connecting.',
      );
    }
  });

  it('matches the example from the specification', () => {
    const result = renderTemplate(
      'Hi {{firstName}}, I came across your profile and thought it would be worth connecting.',
      lead,
      LIMIT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(
        'Hi John, I came across your profile and thought it would be worth connecting.',
      );
    }
  });

  it('REFUSES to render when a used variable is missing', () => {
    const result = renderTemplate('Hi {{firstName}}, ...', { firstName: null }, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'MISSING_VALUES') {
      expect(result.missing).toEqual(['firstName']);
    } else {
      throw new Error('expected MISSING_VALUES');
    }
  });

  it('treats a whitespace-only value as missing', () => {
    const result = renderTemplate('Hi {{firstName}}', { firstName: '   ' }, LIMIT);
    expect(result.ok).toBe(false);
  });

  it('ignores a missing variable the template does not use', () => {
    const result = renderTemplate('Hi {{firstName}}', { firstName: 'John', company: null }, LIMIT);
    expect(result.ok).toBe(true);
  });

  it('refuses unsupported variables', () => {
    const result = renderTemplate('Hi {{firstName}}, your {{industry}}', lead, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'UNKNOWN_VARIABLES') {
      expect(result.unknown).toEqual(['industry']);
    } else {
      throw new Error('expected UNKNOWN_VARIABLES');
    }
  });

  it('refuses a note over the configured length limit', () => {
    const result = renderTemplate('x'.repeat(400), lead, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'TOO_LONG') {
      expect(result.length).toBe(400);
      expect(result.limit).toBe(280);
    } else {
      throw new Error('expected TOO_LONG');
    }
  });

  it('accepts a note exactly at the limit', () => {
    const result = renderTemplate('x'.repeat(280), lead, LIMIT);
    expect(result.ok).toBe(true);
  });

  it('collapses stray spaces but keeps paragraph breaks', () => {
    const result = renderTemplate('Hi   {{firstName}} ,\n\nthanks.', lead, LIMIT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('Hi John ,\n\nthanks.');
  });

  it('refuses an empty result', () => {
    const result = renderTemplate('   ', lead, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EMPTY_RESULT');
  });

  it('does not let a lead value inject a new placeholder', () => {
    const result = renderTemplate('Hi {{firstName}}', { firstName: '{{lastName}}' }, LIMIT);
    expect(result.ok).toBe(true);
    // The substituted value is treated as literal text, not re-scanned.
    if (result.ok) expect(result.text).toBe('Hi {{lastName}}');
  });
});

describe('describeRenderFailure', () => {
  it('explains a missing value in operator-facing language', () => {
    const result = renderTemplate('Hi {{company}}', { company: null }, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(describeRenderFailure(result)).toContain('{{company}}');
    }
  });

  it('lists the supported variables when an unknown one is used', () => {
    const result = renderTemplate('Hi {{nope}}', {}, LIMIT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = describeRenderFailure(result);
      expect(message).toContain('{{firstName}}');
      expect(message).toContain('{{nope}}');
    }
  });
});

describe('worstCaseRenderedLength', () => {
  it('finds the longest render and counts leads that would exceed the limit', () => {
    const contexts = [
      { firstName: 'Jo', company: 'Acme' },
      { firstName: 'Bartholomew', company: 'A Very Long Company Name Indeed Limited' },
    ];
    const result = worstCaseRenderedLength(
      'Hi {{firstName}} at {{company}}',
      contexts,
      { maxLength: 25 },
    );
    expect(result.longest).toBeGreaterThan(25);
    expect(result.offendingCount).toBe(1);
  });
});
