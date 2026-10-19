import { describe, expect, test } from 'vitest';
import {
  HistoryError,
  parseHistory,
  treeAtRound,
  type LabeledHistory,
} from './history.ts';
import { cleanHistory, sampleHistory, type JsonHistory } from './testing.ts';

type Mutation = (history: JsonHistory) => void;

const defect = (history: JsonHistory, index: number): Record<string, unknown> =>
  history.labels.defects[index] as Record<string, unknown>;
const location = (
  history: JsonHistory,
  index: number,
): Record<string, unknown> =>
  defect(history, index)['location'] as Record<string, unknown>;
const round = (history: JsonHistory, index: number): Record<string, unknown> =>
  history.source.rounds[index] as Record<string, unknown>;
const expected = (
  history: JsonHistory,
  index: number,
): Record<string, unknown> =>
  history.expected[index] as Record<string, unknown>;

function failure(mutate: Mutation): HistoryError {
  const history = sampleHistory();
  mutate(history);
  try {
    parseHistory(history);
  } catch (error) {
    expect(error).toBeInstanceOf(HistoryError);
    return error as HistoryError;
  }
  throw new Error('parseHistory accepted the history');
}

describe('parseHistory', () => {
  test('accepts the sample and builds each round tree', () => {
    const history = parseHistory(sampleHistory());
    expect(history.id).toBe('sample');
    expect(history.labels.defects.map((entry) => entry.id)).toEqual([
      'divide',
      'comment',
      'vendored',
    ]);
    expect(treeAtRound(history, 0)).toEqual(
      new Map([['src/a.ts', ['export const a = 1;']]]),
    );
    expect(treeAtRound(history, 3).get('src/a.ts')?.[1]).toBe(
      '  return x / 2;',
    );
    expect([...treeAtRound(history, 3).keys()].sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'vendor/v.js',
    ]);
  });

  test('accepts a clean history, deletions, and a check by a second person', () => {
    const history = cleanHistory();
    history.source.rounds.push({
      number: 2,
      trigger: 'synchronize',
      message: 'Remove a',
      actions: [],
      changes: { 'src/a.ts': null },
    });
    history.expected.push({
      round: 2,
      coverage: 'complete',
      excludedPaths: [],
      inference: true,
      publish: [],
      transitions: [],
    });
    history.labels['check'] = {
      status: 'confirmed',
      by: 'checker-b',
      on: '2026-10-20',
      notes: 'Agreed.',
    };
    const parsed: LabeledHistory = parseHistory(history);
    expect(treeAtRound(parsed, 2).has('src/a.ts')).toBe(false);
    expect(parsed.labels.check).toEqual({
      status: 'confirmed',
      by: 'checker-b',
      on: '2026-10-20',
      notes: 'Agreed.',
    });
  });

  test('accepts a partial fix and a defect first published in a later round', () => {
    const history = sampleHistory();
    history['scenarios'] = ['incremental-fix'];
    defect(history, 0)['fixedRound'] = 3;
    round(history, 2)['changes'] = {
      'src/a.ts': ['export function f(x: number) {', '  return x / 3;', '}'],
    };
    expected(history, 0)['publish'] = ['comment'];
    expected(history, 1)['publish'] = ['divide'];
    expected(history, 1)['transitions'] = [
      { defect: 'comment', status: 'dismissed' },
    ];
    expected(history, 2)['inference'] = true;
    expected(history, 2)['transitions'] = [
      { defect: 'divide', status: 'fixed' },
    ];
    history.labels.decoys = [];
    expect(() => parseHistory(history)).not.toThrow();

    history['scenarios'] = ['partial-fix'];
    expected(history, 1)['publish'] = [];
    expected(history, 0)['publish'] = ['divide', 'comment'];
    expected(history, 1)['transitions'] = [
      { defect: 'divide', status: 'persists' },
      { defect: 'comment', status: 'dismissed' },
    ];
    expect(parseHistory(history).expected[1]?.transitions[0]?.status).toBe(
      'persists',
    );
  });

  test('accepts a dismissal that closes a defect before its fix', () => {
    const history = sampleHistory();
    defect(history, 1)['fixedRound'] = 3;
    round(history, 2)['changes'] = { 'src/b.ts': ['export const b = 3;'] };
    history['scenarios'] = ['dismissed-finding'];
    expect(() => parseHistory(history)).not.toThrow();
  });

  test('treeAtRound refuses a round outside the history', () => {
    const history = parseHistory(sampleHistory());
    expect(() => treeAtRound(history, 4)).toThrow(RangeError);
    expect(() => treeAtRound(history, -1)).toThrow(RangeError);
    expect(() => treeAtRound(history, 1.5)).toThrow(RangeError);
  });

  test('refuses values that are not histories', () => {
    expect(() => parseHistory(null)).toThrow('history: must be an object');
    expect(() => parseHistory([])).toThrow('must be an object');
  });

  const cases: Array<[string, Mutation, string]> = [
    [
      'unknown keys',
      (h) => void (h['mockResponses'] = []),
      'unknown key mockResponses',
    ],
    ['missing keys', (h) => void delete h['title'], 'missing key title'],
    ['schema version', (h) => void (h['schemaVersion'] = 2), 'must be 1'],
    ['bad id', (h) => void (h['id'] = 'Bad_Id'), 'lowercase words'],
    ['empty title', (h) => void (h['title'] = ' '), 'non-empty string'],
    [
      'unknown language',
      (h) => void (h['language'] = 'rust'),
      'must be one of',
    ],
    [
      'bad date',
      (h) =>
        void ((h['provenance'] as Record<string, unknown>)['createdOn'] =
          '2026-13-45'),
      'YYYY-MM-DD',
    ],
    [
      'non-synthetic origin',
      (h) =>
        void ((h['provenance'] as Record<string, unknown>)['origin'] =
          'private'),
      'provenance.origin',
    ],
    [
      'scenarios not a list',
      (h) => void (h['scenarios'] = 'clean-pr'),
      'must be an array',
    ],
    [
      'no scenarios',
      (h) => void (h['scenarios'] = []),
      'scenarios: must not be empty',
    ],
    [
      'repeated scenario',
      (h) => void (h['scenarios'] = ['cross-file', 'cross-file']),
      'repeats cross-file',
    ],
    [
      'line breaks',
      (h) => void (h.source.base['src/a.ts'] = ['a\nb']),
      'without line breaks',
    ],
    [
      'base deletion',
      (h) =>
        void ((h.source.base as Record<string, unknown>)['src/a.ts'] = null),
      'must be an array',
    ],
    [
      'bad path',
      (h) => void (h.source.base['../a.ts'] = []),
      'Repository path',
    ],
    [
      'changes not a map',
      (h) => void (round(h, 0)['changes'] = []),
      'object of paths',
    ],
    [
      'zero round number',
      (h) => void (round(h, 0)['number'] = 0),
      'positive integer',
    ],
    [
      'wrong round number',
      (h) => void (round(h, 1)['number'] = 3),
      'must be round 2',
    ],
    [
      'no rounds',
      (h) => void (h.source.rounds = []),
      'source.rounds: must not be empty',
    ],
    [
      'first round not opened',
      (h) => void (round(h, 0)['trigger'] = 'synchronize'),
      'first round must be opened',
    ],
    [
      'later round opened',
      (h) => void (round(h, 2)['trigger'] = 'opened'),
      'only the first round',
    ],
    [
      'deleting a missing path',
      (h) => void (round(h, 2)['changes'] = { 'src/z.ts': null }),
      'deletes src/z.ts',
    ],
    [
      'unknown action',
      (h) =>
        void (round(h, 1)['actions'] = [
          { kind: 'resolve', defect: 'comment', reason: 'x' },
        ]),
      'must be one of dismiss',
    ],
    [
      'check not an object',
      (h) => void (h.labels['check'] = 'pending'),
      'labels.check: must be an object',
    ],
    [
      'pending check with extra keys',
      (h) => void (h.labels['check'] = { status: 'pending', by: 'x' }),
      'unknown key by',
    ],
    [
      'checker is the labeler',
      (h) =>
        void (h.labels['check'] = {
          status: 'amended',
          by: 'labeler-a',
          on: '2026-10-19',
          notes: 'Changed a severity.',
        }),
      'checker must not be the labeler',
    ],
    [
      'eligible not boolean',
      (h) => void (defect(h, 0)['eligible'] = 'yes'),
      'true or false',
    ],
    [
      'negative location round',
      (h) => void (location(h, 0)['round'] = -1),
      '0 for the base',
    ],
    [
      'repeated label ids',
      (h) =>
        void ((h.labels.decoys[0] as Record<string, unknown>)['id'] = 'divide'),
      'labels: repeats divide',
    ],
    [
      'category mismatch',
      (h) => void (defect(h, 0)['failureMode'] = 'injection'),
      'not a correctness failure mode',
    ],
    [
      'purpose mismatch below critical',
      (h) => void (defect(h, 0)['failureMode'] = 'purpose-mismatch'),
      'always critical',
    ],
    [
      'introduced after the end',
      (h) => void (defect(h, 1)['introducedRound'] = 4),
      'after the last round',
    ],
    [
      'fix before introduction',
      (h) => void (defect(h, 0)['fixedRound'] = 1),
      'must follow the introduction',
    ],
    [
      'fix after the end',
      (h) => void (defect(h, 0)['fixedRound'] = 4),
      'must follow the introduction',
    ],
    [
      'location in another round',
      (h) => void (location(h, 0)['round'] = 2),
      'must be the introduction round',
    ],
    [
      'round outside the history',
      (h) =>
        void ((
          h.labels.decoys[0] as { location: Record<string, unknown> }
        ).location['round'] = 9),
      'round 9 does not exist',
    ],
    [
      'path missing in round',
      (h) => void (location(h, 1)['path'] = 'src/z.ts'),
      'src/z.ts does not exist at round 1',
    ],
    [
      'lines outside file',
      (h) => void (location(h, 0)['endLine'] = 9),
      'outside src/a.ts',
    ],
    [
      'reversed lines',
      (h) => void (location(h, 0)['startLine'] = 3),
      'outside src/a.ts',
    ],
    [
      'marker missing',
      (h) => void (location(h, 0)['marker'] = 'x / 9'),
      'marker text is not in the labeled lines',
    ],
    [
      'no evidence',
      (h) => void (defect(h, 0)['requiredEvidence'] = []),
      'requiredEvidence: must not be empty',
    ],
    [
      'evidence after introduction',
      (h) =>
        void (defect(h, 0)['requiredEvidence'] = [
          {
            path: 'src/a.ts',
            round: 2,
            startLine: 2,
            endLine: 2,
            marker: 'x / 2',
          },
        ]),
      'must not be after the introduction round',
    ],
    [
      'ineligible but available',
      (h) => void (defect(h, 2)['available'] = true),
      'an ineligible defect is never available',
    ],
    ['expected per round', (h) => void h.expected.pop(), 'one entry per round'],
    [
      'expected round number',
      (h) => void (expected(h, 1)['round'] = 3),
      'must be round 2',
    ],
    [
      'repeated excluded path',
      (h) =>
        void (expected(h, 0)['excludedPaths'] = ['vendor/v.js', 'vendor/v.js']),
      'repeats vendor/v.js',
    ],
    [
      'excluded but unchanged',
      (h) => void (expected(h, 1)['excludedPaths'] = ['vendor/v.js']),
      'is not changed in this round',
    ],
    [
      'complete with exclusions',
      (h) => void (expected(h, 0)['coverage'] = 'complete'),
      'cannot be complete with excluded paths',
    ],
    [
      'publish without inference',
      (h) => void (expected(h, 0)['inference'] = false),
      'publishes nothing',
    ],
    [
      'dismissing an unknown defect',
      (h) =>
        void (round(h, 1)['actions'] = [
          { kind: 'dismiss', defect: 'nope', reason: 'x' },
        ]),
      'unknown defect nope',
    ],
    [
      'dismissing an unpublished defect',
      (h) =>
        void (round(h, 0)['actions'] = [
          { kind: 'dismiss', defect: 'comment', reason: 'x' },
        ]),
      'comment is not an open published finding',
    ],
    [
      'publishing an unknown defect',
      (h) => void (expected(h, 0)['publish'] = ['divide', 'comment', 'nope']),
      'unknown defect nope',
    ],
    [
      'publishing an ineligible defect',
      (h) =>
        void (expected(h, 0)['publish'] = ['divide', 'comment', 'vendored']),
      'vendored is not eligible and available',
    ],
    [
      'publishing a fixed defect',
      (h) => {
        expected(h, 0)['publish'] = ['comment'];
        expected(h, 1)['publish'] = ['divide'];
        expected(h, 1)['transitions'] = [
          { defect: 'comment', status: 'dismissed' },
        ];
      },
      'divide is not present in this round',
    ],
    [
      'publishing twice',
      (h) => void (expected(h, 0)['publish'] = ['divide', 'divide']),
      'repeats divide',
    ],
    [
      'publishing after publication',
      (h) => {
        expected(h, 1)['publish'] = ['comment'];
        expected(h, 1)['transitions'] = [{ defect: 'divide', status: 'fixed' }];
        round(h, 1)['actions'] = [];
      },
      'comment was already published',
    ],
    [
      'repeated transition',
      (h) =>
        void (expected(h, 1)['transitions'] = [
          { defect: 'divide', status: 'fixed' },
          { defect: 'divide', status: 'fixed' },
        ]),
      'repeats divide',
    ],
    [
      'transition before publication',
      (h) =>
        void (expected(h, 0)['transitions'] = [
          { defect: 'divide', status: 'persists' },
        ]),
      'divide is not an open finding from an earlier round',
    ],
    [
      'dismissed transition without an action',
      (h) => {
        round(h, 1)['actions'] = [];
      },
      'comment has no dismiss action this round',
    ],
    [
      'dismissal without a transition',
      (h) =>
        void (expected(h, 1)['transitions'] = [
          { defect: 'divide', status: 'fixed' },
        ]),
      'the dismissal of comment is not expected',
    ],
    [
      'assessment without inference',
      (h) => {
        expected(h, 1)['inference'] = false;
      },
      'assessing a finding needs inference',
    ],
    [
      'fixed in the wrong round',
      (h) => {
        defect(h, 0)['fixedRound'] = 3;
        round(h, 2)['changes'] = {
          'src/a.ts': [
            'export function f(x: number) {',
            '  return x / 2;',
            '}',
            '',
          ],
        };
        expected(h, 2)['inference'] = true;
      },
      'divide is not fixed in this round',
    ],
    [
      'persisting after the fix',
      (h) => {
        expected(h, 1)['transitions'] = [
          { defect: 'comment', status: 'dismissed' },
        ];
        expected(h, 2)['inference'] = true;
        expected(h, 2)['transitions'] = [
          { defect: 'divide', status: 'persists' },
        ];
      },
      'divide no longer persists',
    ],
    [
      'never published',
      (h) => {
        expected(h, 0)['publish'] = ['divide'];
        expected(h, 1)['transitions'] = [{ defect: 'divide', status: 'fixed' }];
        round(h, 1)['actions'] = [];
      },
      'comment is never published',
    ],
    [
      'no fixed transition',
      (h) =>
        void (expected(h, 1)['transitions'] = [
          { defect: 'comment', status: 'dismissed' },
        ]),
      'divide has no fixed transition',
    ],
    [
      'ineligible path not excluded',
      (h) => void (expected(h, 0)['excludedPaths'] = []),
      'vendored is ineligible but vendor/v.js is not excluded',
    ],
    [
      'clean-pr with defects',
      (h) => void (h['scenarios'] = ['clean-pr']),
      'clean-pr is not supported',
    ],
    [
      'late round claimed',
      (h) => void (h['scenarios'] = ['late-round-regression']),
      'late-round-regression is not supported',
    ],
    [
      'partial fix claimed',
      (h) => void (h['scenarios'] = ['partial-fix']),
      'partial-fix is not supported',
    ],
  ];

  test.each(cases)('refuses %s', (_name, mutate, message) => {
    expect(failure(mutate).message).toContain(message);
  });

  test('ties every scenario tag to the labels', () => {
    const history = cleanHistory();
    for (const scenario of [
      'correct-high-severity',
      'false-positive',
      'incremental-fix',
      'dismissed-finding',
      'unreviewable-change',
      'cross-file',
    ]) {
      history['scenarios'] = [scenario];
      expect(() => parseHistory(history), scenario).toThrow(
        `${scenario} is not supported`,
      );
    }
  });
});
