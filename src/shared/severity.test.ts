import { describe, expect, it } from 'vitest';
import { thrown } from '../../tests/support/thrown.ts';
import { normalizeSeverity, severities } from './severity.ts';
import { ValidationError } from './validation.ts';

describe('normalizeSeverity', () => {
  it.each(severities)('accepts %s', (severity) => {
    expect(normalizeSeverity(severity)).toBe(severity);
  });

  it('ignores letter case and surrounding whitespace', () => {
    expect(normalizeSeverity(' High\n')).toBe('high');
    expect(normalizeSeverity('CRITICAL')).toBe('critical');
  });

  it.each(['moderate', 'info', 'severe', 'med', '', 'high!', 'h igh'])(
    'refuses the unsupported severity %j',
    (raw) => {
      const error = thrown(() => normalizeSeverity(raw));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ code: 'unknown-severity' });
    },
  );

  it.each([undefined, null, 3, ['high']])(
    'refuses the non-string %j',
    (raw) => {
      expect(() => normalizeSeverity(raw)).toThrow(ValidationError);
    },
  );
});
