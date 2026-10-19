import { describe, expect, test } from 'vitest';
import { lintStrictSchema, probeSchema, validate } from './schema.ts';

const finding = {
  path: 'src/a.ts',
  line: 3,
  severity: 'major',
  title: 'Off by one',
  body: 'The loop skips the last entry.',
  introducedBy: { path: 'src/a.ts', startLine: 3, endLine: 4 },
  claim: null,
};

const output = (overrides: Record<string, unknown> = {}) => ({
  candidateFindings: [finding],
  priorFindingUpdates: [
    { findingId: 'F1', proposal: 'fixed', reason: 'Guard added.' },
  ],
  walkthrough: 'One change.',
  limitations: [],
  ...overrides,
});

describe('probeSchema', () => {
  test('every variant passes the strict-mode lint', () => {
    for (const variant of ['full', 'incremental', 'reconcile'] as const) {
      expect(lintStrictSchema(probeSchema(variant))).toEqual([]);
    }
  });

  test('variants differ only where §15.3 says they do', () => {
    const full = probeSchema('full');
    const incremental = probeSchema('incremental');
    const reconcile = probeSchema('reconcile');
    const props = (s: Record<string, unknown>) =>
      s['properties'] as Record<string, unknown>;
    expect(props(full)['walkthrough']).toEqual({ type: ['string', 'null'] });
    expect(props(incremental)['walkthrough']).toEqual({ type: 'null' });
    expect(props(reconcile)['candidateFindings']).toMatchObject({
      maxItems: 0,
    });
    expect(props(incremental)['candidateFindings']).toEqual(
      props(full)['candidateFindings'],
    );
  });
});

describe('lintStrictSchema', () => {
  test('reports open objects, optional properties and unknown keywords', () => {
    expect(
      lintStrictSchema({
        type: 'object',
        properties: {
          a: { type: 'string', pattern: '^x' },
          b: {
            type: 'array',
            items: { type: 'object', properties: {}, required: [] },
          },
          c: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: { d: { type: 'string' } },
                additionalProperties: false,
                required: [],
              },
            ],
          },
        },
        required: ['a'],
      }),
    ).toEqual([
      { pointer: '', problem: 'additionalProperties is not false' },
      { pointer: '', problem: 'required does not list every property' },
      { pointer: '/properties/a', problem: 'unsupported keyword pattern' },
      {
        pointer: '/properties/b/items',
        problem: 'additionalProperties is not false',
      },
      {
        pointer: '/properties/c/anyOf/1',
        problem: 'required does not list every property',
      },
    ]);
  });
});

describe('validate', () => {
  test('accepts a conforming full response', () => {
    expect(validate(output(), probeSchema('full'))).toEqual([]);
    expect(
      validate(
        output({
          walkthrough: null,
          candidateFindings: [
            {
              ...finding,
              claim: {
                statement: 'x',
                references: [{ path: 'a', startLine: 1, endLine: 1 }],
              },
            },
          ],
        }),
        probeSchema('full'),
      ),
    ).toEqual([]);
  });

  test('enforces the incremental and reconcile restrictions', () => {
    expect(validate(output(), probeSchema('incremental'))).toEqual([
      '/walkthrough: expected null, got string',
    ]);
    expect(
      validate(output({ walkthrough: null }), probeSchema('reconcile')),
    ).toEqual(['/candidateFindings: more than 0 items']);
  });

  test('reports type, enum, minimum, anyOf and property errors', () => {
    const errors = validate(
      output({
        candidateFindings: [
          {
            ...finding,
            line: 0,
            severity: 'huge',
            claim: 'yes',
            extra: true,
          },
        ],
        priorFindingUpdates: [{ findingId: 'F1', proposal: 'fixed' }],
        limitations: 'none',
      }),
      probeSchema('full'),
    );
    expect(errors).toEqual([
      '/candidateFindings/0/line: below 1',
      '/candidateFindings/0/severity: not one of critical, major, minor',
      '/candidateFindings/0/claim: matches no anyOf branch',
      '/candidateFindings/0: unexpected property extra',
      '/priorFindingUpdates/0: missing reason',
      '/limitations: expected array, got string',
    ]);
  });

  test('treats an integer as a number and tolerates unknown extras when allowed', () => {
    expect(validate(3, { type: 'number' })).toEqual([]);
    expect(validate(3.5, { type: 'integer' })).toEqual([
      ': expected integer, got number',
    ]);
    expect(
      validate({ a: 1, b: 2 }, { type: 'object', properties: { a: {} } }),
    ).toEqual([]);
    expect(validate([1], { type: 'array' })).toEqual([]);
  });
});
