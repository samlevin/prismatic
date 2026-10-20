// Finding severities. Only these four exist; anything else is refused rather
// than mapped to a nearby level.
import { ValidationError } from './validation.ts';

export const severities = ['low', 'medium', 'high', 'critical'] as const;

export type Severity = (typeof severities)[number];

const known: ReadonlySet<string> = new Set(severities);

function isSeverity(value: string): value is Severity {
  return known.has(value);
}

// Accepts a supported severity in any letter case, with surrounding
// whitespace, such as `High` from model output.
export function normalizeSeverity(raw: unknown): Severity {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined;
  if (value === undefined || !isSeverity(value)) {
    throw new ValidationError(
      'unknown-severity',
      `Severity must be one of ${severities.join(', ')}.`,
    );
  }
  return value;
}
