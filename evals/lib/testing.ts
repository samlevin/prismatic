// A small history that uses every part of the format, for the unit tests.
// Each call returns a fresh copy the caller may mutate.
//
// Round 1 adds a high-severity defect (`divide`), a low-severity one
// (`comment`), a decoy, and an ineligible defect in a vendored file. Round 2
// fixes `divide` and the author dismisses `comment`. Round 3 is an empty push.

export type JsonHistory = Record<string, unknown> & {
  source: {
    base: Record<string, string[]>;
    rounds: Array<
      Record<string, unknown> & { changes: Record<string, unknown> }
    >;
  };
  labels: Record<string, unknown> & {
    defects: Array<Record<string, unknown>>;
    decoys: Array<Record<string, unknown>>;
  };
  expected: Array<Record<string, unknown>>;
};

export function sampleHistory(): JsonHistory {
  return {
    schemaVersion: 1,
    id: 'sample',
    title: 'Sample history',
    language: 'typescript',
    provenance: {
      origin: 'synthetic',
      author: 'labeler-a',
      createdOn: '2026-10-19',
      license: 'MIT',
      notes: 'Written for the unit tests.',
    },
    scenarios: [
      'correct-high-severity',
      'false-positive',
      'incremental-fix',
      'dismissed-finding',
      'unreviewable-change',
      'cross-file',
    ],
    pullRequest: { title: 'Add f', body: 'Adds f.' },
    source: {
      base: { 'src/a.ts': ['export const a = 1;'] },
      rounds: [
        {
          number: 1,
          trigger: 'opened',
          message: 'Add f',
          actions: [],
          changes: {
            'src/a.ts': [
              'export function f(x: number) {',
              '  return x / 0;',
              '}',
            ],
            'src/b.ts': ['// Returns two.', 'export const b = 3;'],
            'vendor/v.js': ['eval(input);'],
          },
        },
        {
          number: 2,
          trigger: 'synchronize',
          message: 'Fix f',
          actions: [
            { kind: 'dismiss', defect: 'comment', reason: 'Fixed later.' },
          ],
          changes: {
            'src/a.ts': [
              'export function f(x: number) {',
              '  return x / 2;',
              '}',
            ],
          },
        },
        {
          number: 3,
          trigger: 'force-push',
          message: 'Rebase',
          actions: [],
          changes: {},
        },
      ],
    },
    labels: {
      labeledBy: 'labeler-a',
      labeledOn: '2026-10-19',
      check: { status: 'pending' },
      defects: [
        {
          id: 'divide',
          severity: 'high',
          category: 'correctness',
          failureMode: 'logic-error',
          introducedRound: 1,
          fixedRound: 2,
          location: {
            path: 'src/a.ts',
            round: 1,
            startLine: 2,
            endLine: 2,
            marker: 'x / 0',
          },
          requiredEvidence: [
            {
              path: 'src/a.ts',
              round: 1,
              startLine: 1,
              endLine: 3,
              marker: 'x / 0',
            },
          ],
          eligible: true,
          available: true,
          summary: 'Divides by zero.',
        },
        {
          id: 'comment',
          severity: 'low',
          category: 'quality',
          failureMode: 'misleading-name-or-comment',
          introducedRound: 1,
          fixedRound: null,
          location: {
            path: 'src/b.ts',
            round: 1,
            startLine: 1,
            endLine: 2,
            marker: 'Returns two',
          },
          requiredEvidence: [
            {
              path: 'src/b.ts',
              round: 1,
              startLine: 2,
              endLine: 2,
              marker: 'b = 3',
            },
          ],
          eligible: true,
          available: true,
          summary: 'The comment says two; the value is three.',
        },
        {
          id: 'vendored',
          severity: 'critical',
          category: 'security',
          failureMode: 'unsafe-deserialization-or-eval',
          introducedRound: 1,
          fixedRound: null,
          location: {
            path: 'vendor/v.js',
            round: 1,
            startLine: 1,
            endLine: 1,
            marker: 'eval',
          },
          requiredEvidence: [
            {
              path: 'src/a.ts',
              round: 0,
              startLine: 1,
              endLine: 1,
              marker: 'a = 1',
            },
          ],
          eligible: false,
          available: false,
          summary: 'Evaluates input, inside an excluded vendored file.',
        },
      ],
      decoys: [
        {
          id: 'looks-unsafe',
          location: {
            path: 'src/a.ts',
            round: 2,
            startLine: 2,
            endLine: 2,
            marker: 'x / 2',
          },
          summary: 'Division by a constant two is safe.',
        },
      ],
    },
    expected: [
      {
        round: 1,
        coverage: 'partial',
        excludedPaths: ['vendor/v.js'],
        inference: true,
        publish: ['divide', 'comment'],
        transitions: [],
      },
      {
        round: 2,
        coverage: 'complete',
        excludedPaths: [],
        inference: true,
        publish: [],
        transitions: [
          { defect: 'divide', status: 'fixed' },
          { defect: 'comment', status: 'dismissed' },
        ],
      },
      {
        round: 3,
        coverage: 'complete',
        excludedPaths: [],
        inference: false,
        publish: [],
        transitions: [],
      },
    ],
  };
}

// A one-round history with no defects.
export function cleanHistory(id = 'clean'): JsonHistory {
  const history = sampleHistory();
  history['id'] = id;
  history['scenarios'] = ['clean-pr'];
  history.source.rounds = [
    {
      number: 1,
      trigger: 'opened',
      message: 'Add c',
      actions: [],
      changes: { 'src/c.ts': ['export const c = 1;'] },
    },
  ];
  history.labels.defects = [];
  history.labels.decoys = [];
  history.expected = [
    {
      round: 1,
      coverage: 'complete',
      excludedPaths: [],
      inference: true,
      publish: [],
      transitions: [],
    },
  ];
  return history;
}
