// The strict JSON response schema the spike sends, in the three §15.3
// variants, plus a linter for the strict-mode subset and a validator for the
// keywords the probe uses. The real ReviewDecision schema comes from §11.1
// (#136); this probe only exercises the constructs that schema will need:
// every property required, nullable values, an anyOf-nullable object, enums,
// integers, a `null`-only walkthrough and `maxItems: 0`.

export type JsonSchema = { readonly [keyword: string]: unknown };

export type SchemaVariant = 'full' | 'incremental' | 'reconcile';

const string = { type: 'string' } as const;
const line = { type: 'integer', minimum: 1 } as const;

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const range = object({ path: string, startLine: line, endLine: line });

const finding = object({
  path: string,
  line,
  severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
  title: string,
  body: string,
  introducedBy: range,
  claim: {
    anyOf: [
      { type: 'null' },
      object({
        statement: string,
        references: { type: 'array', items: range },
      }),
    ],
  },
});

const update = object({
  findingId: string,
  proposal: { type: 'string', enum: ['fixed', 'persists', 'uncertain'] },
  reason: string,
});

export function probeSchema(variant: SchemaVariant): JsonSchema {
  return object({
    candidateFindings:
      variant === 'reconcile'
        ? { type: 'array', items: finding, maxItems: 0 }
        : { type: 'array', items: finding },
    priorFindingUpdates: { type: 'array', items: update },
    walkthrough:
      variant === 'full' ? { type: ['string', 'null'] } : { type: 'null' },
    limitations: { type: 'array', items: string },
  });
}

// Keywords the probe relies on. The live run is what shows the provider
// accepts them under `strict: true`; this list only keeps the probe from
// drifting into keywords nobody verified.
const allowedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'minimum',
  'maxItems',
  'description',
]);

export interface SchemaProblem {
  readonly pointer: string;
  readonly problem: string;
}

// Problems that would make a schema unfit for strict structured output:
// unknown keywords, objects that allow additional properties, and optional
// properties (strict mode requires every property; optional values are
// nullable instead).
export function lintStrictSchema(
  schema: JsonSchema,
  pointer = '',
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  for (const keyword of Object.keys(schema)) {
    if (!allowedKeywords.has(keyword)) {
      problems.push({ pointer, problem: `unsupported keyword ${keyword}` });
    }
  }
  const properties = schema['properties'] as
    Record<string, JsonSchema> | undefined;
  if (schema['type'] === 'object' || properties !== undefined) {
    if (schema['additionalProperties'] !== false) {
      problems.push({ pointer, problem: 'additionalProperties is not false' });
    }
    const keys = Object.keys(properties ?? {}).sort();
    const required = [
      ...((schema['required'] as string[] | undefined) ?? []),
    ].sort();
    if (keys.join('\0') !== required.join('\0')) {
      problems.push({
        pointer,
        problem: 'required does not list every property',
      });
    }
    for (const [key, child] of Object.entries(properties ?? {})) {
      problems.push(...lintStrictSchema(child, `${pointer}/properties/${key}`));
    }
  }
  const items = schema['items'] as JsonSchema | undefined;
  if (items !== undefined)
    problems.push(...lintStrictSchema(items, `${pointer}/items`));
  const anyOf = (schema['anyOf'] as JsonSchema[] | undefined) ?? [];
  anyOf.forEach((branch, i) => {
    problems.push(...lintStrictSchema(branch, `${pointer}/anyOf/${i}`));
  });
  return problems;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(actual: string, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some(
    (type) => type === actual || (type === 'number' && actual === 'integer'),
  );
}

// Validates a parsed response against a probe schema. It understands only
// the keywords in `allowedKeywords`, which is all the probe uses.
export function validate(
  value: unknown,
  schema: JsonSchema,
  pointer = '',
): string[] {
  const anyOf = schema['anyOf'] as JsonSchema[] | undefined;
  if (anyOf !== undefined) {
    return anyOf.some((branch) => validate(value, branch, pointer).length === 0)
      ? []
      : [`${pointer}: matches no anyOf branch`];
  }
  const actual = typeOf(value);
  if (schema['type'] !== undefined && !typeMatches(actual, schema['type'])) {
    return [`${pointer}: expected ${String(schema['type'])}, got ${actual}`];
  }
  const errors: string[] = [];
  const allowed = schema['enum'] as unknown[] | undefined;
  if (allowed !== undefined && !allowed.includes(value)) {
    errors.push(`${pointer}: not one of ${allowed.join(', ')}`);
  }
  const minimum = schema['minimum'] as number | undefined;
  if (minimum !== undefined && typeof value === 'number' && value < minimum) {
    errors.push(`${pointer}: below ${minimum}`);
  }
  if (actual === 'array') {
    const list = value as unknown[];
    const maxItems = schema['maxItems'] as number | undefined;
    if (maxItems !== undefined && list.length > maxItems) {
      errors.push(`${pointer}: more than ${maxItems} items`);
    }
    const items = schema['items'] as JsonSchema | undefined;
    list.forEach((item, i) => {
      if (items !== undefined)
        errors.push(...validate(item, items, `${pointer}/${i}`));
    });
  }
  if (actual === 'object') {
    const record = value as Record<string, unknown>;
    const properties =
      (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {};
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${pointer}: missing ${key}`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema['additionalProperties'] === false) {
          errors.push(`${pointer}: unexpected property ${key}`);
        }
      } else errors.push(...validate(child, childSchema, `${pointer}/${key}`));
    }
  }
  return errors;
}
