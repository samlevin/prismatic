import { describe, expect, test } from 'vitest';
import type { Rates, RequestRecord } from './cost.ts';
import { fileURLToPath } from 'node:url';
import { loadHistories } from './corpus.ts';
import { parseHistory, type LabeledHistory } from './history.ts';
import {
  pairedLossUpperBound,
  scoreRun,
  scoreVariant,
  type ObservedRound,
  type RunObservation,
} from './metrics.ts';
import { cleanHistory, sampleHistory } from './testing.ts';

const rates: Rates = {
  inputPerMillion: 2,
  cacheWritePerMillion: 2.5,
  cachedInputPerMillion: 0.1,
  outputPerMillion: 10,
};

const pilot = fileURLToPath(new URL('../labeled/pilot/', import.meta.url));
const sample = parseHistory(sampleHistory());
const clean = parseHistory(cleanHistory());

const paid: RequestRecord = {
  purpose: 'discovery',
  outcome: 'completed',
  usage: {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  reservedUsd: 3,
};

function observedRound(
  round: number,
  parts: Partial<ObservedRound> = {},
): ObservedRound {
  return {
    round,
    requests: [paid],
    latencyMs: 1000,
    published: [],
    transitions: [],
    ...parts,
  };
}

// Finds both eligible defects, fixes one, and makes no call on the empty push.
function perfectRun(run = 1, variant = 'delta'): RunObservation {
  return {
    history: 'sample',
    variant,
    run,
    rounds: [
      observedRound(1, {
        published: [
          {
            id: 'f1',
            severity: 'high',
            defect: 'divide',
            causality: 'supported',
          },
          {
            id: 'f2',
            severity: 'low',
            defect: 'comment',
            causality: 'supported',
          },
        ],
      }),
      observedRound(2, { transitions: [{ finding: 'f1', status: 'fixed' }] }),
      observedRound(3, { requests: [] }),
    ],
    funnel: [
      { defect: 'divide', retrieved: true, discovered: true },
      { defect: 'comment', retrieved: true, discovered: true },
    ],
  };
}

// Every lifecycle and precision failure the scorer counts.
function noisyRun(run = 1): RunObservation {
  return {
    history: 'sample',
    variant: 'delta',
    run,
    rounds: [
      observedRound(1, {
        published: [
          {
            id: 'g1',
            severity: 'high',
            defect: 'divide',
            causality: 'unrelated',
          },
          {
            id: 'g2',
            severity: 'critical',
            defect: null,
            causality: 'supported',
          },
          {
            id: 'g3',
            severity: 'high',
            defect: 'divide',
            causality: 'supported',
          },
          {
            id: 'g4',
            severity: 'medium',
            defect: 'divide',
            causality: 'supported',
          },
        ],
        transitions: [{ finding: 'g3', status: 'fixed' }],
      }),
      observedRound(2, {
        published: [
          {
            id: 'g5',
            severity: 'low',
            defect: 'comment',
            causality: 'supported',
          },
        ],
        transitions: [{ finding: 'g1', status: 'fixed' }],
      }),
      observedRound(3, {
        requests: [
          { ...paid, outcome: 'uncertain', usage: null, reservedUsd: 0.5 },
        ],
      }),
    ],
    funnel: [
      { defect: 'divide', retrieved: true, discovered: true },
      { defect: 'comment', retrieved: true, discovered: true },
    ],
  };
}

describe('scoreRun', () => {
  test('scores a run that finds and closes everything', () => {
    const score = scoreRun(sample, perfectRun(), rates);
    expect(score.precision).toEqual({ successes: 2, trials: 2 });
    expect(score.severePrecision).toEqual({ successes: 1, trials: 1 });
    expect(score.severeRecall).toEqual({ successes: 1, trials: 1 });
    expect(score.retrievalMiss).toEqual({ successes: 0, trials: 1 });
    expect(score.bucketRecall.get(2)).toEqual({ successes: 0, trials: 0 });
    expect(score.falseFindings).toBe(0);
    expect(score.falseFixed).toBe(0);
    expect(score.unexpectedInference).toBe(0);
    expect(score.defectsFound).toBe(2);
    expect(Object.fromEntries(score.funnel)).toEqual({
      divide: null,
      comment: null,
      vendored: 'eligible',
    });
    expect(score.cost.reviewerUsd).toBeCloseTo(4, 12);
    expect(score.latencyMs).toBe(3000);
    expect(score.clean).toBe(false);
  });

  test('counts false, duplicate, resurfaced, falsely fixed, and unneeded work', () => {
    const score = scoreRun(sample, noisyRun(), rates);
    // g1 fails causality, g2 matches nothing, g4 repeats g3; g5 is true.
    expect(score.precision).toEqual({ successes: 2, trials: 5 });
    expect(score.severePrecision).toEqual({ successes: 1, trials: 3 });
    expect(score.falseFindings).toBe(2);
    expect(score.duplicates).toBe(1);
    // g3 is marked fixed in round 1, while the defect is still present. g1
    // fails causality, so its transition is not a lifecycle error.
    expect(score.falseFixed).toBe(1);
    // g5 is the run's first comment finding, so nothing was dismissed in
    // this run and it is not resurfacing.
    expect(score.dismissedResurfaced).toBe(0);
    expect(score.unexpectedInference).toBe(1);
    expect(score.cost.usageComplete).toBe(false);
    expect(score.cost.failedAttemptUsd).toBe(0.5);
  });

  test('counts a dismissed finding published again as resurfacing', () => {
    const run = perfectRun();
    const rounds = [
      run.rounds[0] as ObservedRound,
      run.rounds[1] as ObservedRound,
      observedRound(3, {
        requests: [],
        published: [
          {
            id: 'f3',
            severity: 'low',
            defect: 'comment',
            causality: 'unrelated',
          },
        ],
      }),
    ];
    const score = scoreRun(sample, { ...run, rounds }, rates);
    expect(score.dismissedResurfaced).toBe(1);
    expect(score.falseFindings).toBe(1);
  });

  test('counts a dismissed finding as resurfacing whatever its causality', () => {
    const run = perfectRun();
    const first = {
      ...(run.rounds[0] as ObservedRound),
      published: [
        {
          id: 'f1',
          severity: 'high' as const,
          defect: 'divide',
          causality: 'supported' as const,
        },
        {
          id: 'f2',
          severity: 'low' as const,
          defect: 'comment',
          causality: 'unrelated' as const,
        },
      ],
    };
    const third = observedRound(3, {
      requests: [],
      published: [
        {
          id: 'f3',
          severity: 'low',
          defect: 'comment',
          causality: 'supported',
        },
      ],
    });
    const score = scoreRun(
      sample,
      { ...run, rounds: [first, run.rounds[1] as ObservedRound, third] },
      rates,
    );
    expect(score.dismissedResurfaced).toBe(1);
  });

  test('reports end-to-end severe recall over ineligible defects too', () => {
    const score = scoreRun(sample, perfectRun(), rates);
    expect(score.severeRecallEndToEnd).toEqual({ successes: 1, trials: 2 });
    expect(score.rounds).toBe(3);
  });

  test('reports where a missed defect left the funnel', () => {
    const notRetrieved = perfectRun();
    const run = {
      ...notRetrieved,
      rounds: [
        observedRound(1),
        observedRound(2),
        observedRound(3, { requests: [] }),
      ],
    };
    const lost = (divide: { retrieved: boolean; discovered: boolean }) =>
      scoreRun(
        sample,
        {
          ...run,
          funnel: [
            { defect: 'divide', ...divide },
            { defect: 'comment', retrieved: true, discovered: true },
          ],
        },
        rates,
      );
    expect(
      lost({ retrieved: false, discovered: false }).funnel.get('divide'),
    ).toBe('retrieved');
    expect(lost({ retrieved: false, discovered: false }).retrievalMiss).toEqual(
      {
        successes: 1,
        trials: 1,
      },
    );
    expect(
      lost({ retrieved: true, discovered: false }).funnel.get('divide'),
    ).toBe('discovered');
    const published = lost({ retrieved: true, discovered: true });
    expect(published.funnel.get('divide')).toBe('published');
    expect(published.funnel.get('comment')).toBe('published');
    expect(published.severeRecall).toEqual({ successes: 0, trials: 1 });
  });

  test('labels an eligible defect beyond the caps as unavailable', () => {
    const json = sampleHistory();
    const vendored = json.labels.defects[2] as Record<string, unknown>;
    vendored['eligible'] = true;
    json.expected[0] = {
      ...json.expected[0],
      excludedPaths: [],
      coverage: 'partial',
    };
    json['scenarios'] = ['incremental-fix'];
    const history = parseHistory(json);
    expect(scoreRun(history, perfectRun(), rates).funnel.get('vendored')).toBe(
      'available',
    );
  });

  test('counts severe defects of every introduction round and buckets late ones', () => {
    const json = sampleHistory();
    const comment = json.labels.defects[1] as Record<string, unknown>;
    comment['severity'] = 'high';
    const score = scoreRun(parseHistory(json), perfectRun(), rates);
    expect(score.severeRecall).toEqual({ successes: 2, trials: 2 });
    expect(score.bucketRecall.get(2)).toEqual({ successes: 0, trials: 0 });

    const [late] = loadHistories(pilot).filter(
      (history) => history.id === 'py-counter-late-race',
    );
    const rounds = [1, 2, 3, 4, 5].map((round) => observedRound(round));
    rounds.push(
      observedRound(6, {
        published: [
          {
            id: 'r6',
            severity: 'high',
            defect: 'unlocked-increment',
            causality: 'supported',
          },
        ],
      }),
    );
    const lateScore = scoreRun(
      late as LabeledHistory,
      {
        history: 'py-counter-late-race',
        variant: 'delta',
        run: 1,
        rounds,
        funnel: [
          { defect: 'unlocked-increment', retrieved: true, discovered: true },
        ],
      },
      rates,
    );
    expect(Object.fromEntries(lateScore.bucketRecall)).toEqual({
      2: { successes: 1, trials: 1 },
      6: { successes: 1, trials: 1 },
      12: { successes: 0, trials: 0 },
    });
  });

  const invalid: Array<
    [string, (run: RunObservation) => RunObservation, string]
  > = [
    [
      'another history',
      (run) => ({ ...run, history: 'other' }),
      'is not a run of sample',
    ],
    [
      'missing rounds',
      (run) => ({ ...run, rounds: run.rounds.slice(0, 2) }),
      'must observe all 3 rounds',
    ],
    [
      'misnumbered rounds',
      (run) => ({
        ...run,
        rounds: [
          run.rounds[0],
          observedRound(5),
          run.rounds[2],
        ] as ObservedRound[],
      }),
      'round 1 must be 2',
    ],
    [
      'negative latency',
      (run) => ({
        ...run,
        rounds: [observedRound(1, { latencyMs: -1 }), ...run.rounds.slice(1)],
      }),
      'latency is invalid',
    ],
    [
      'repeated finding ids',
      (run) => ({
        ...run,
        rounds: [
          run.rounds[0] as ObservedRound,
          observedRound(2, {
            published: [
              {
                id: 'f1',
                severity: 'low',
                defect: null,
                causality: 'supported',
              },
            ],
          }),
          run.rounds[2] as ObservedRound,
        ],
      }),
      'finding f1 repeats',
    ],
    [
      'unknown defects',
      (run) => ({
        ...run,
        rounds: [
          observedRound(1, {
            published: [
              {
                id: 'x',
                severity: 'low',
                defect: 'nope',
                causality: 'supported',
              },
            ],
          }),
          ...run.rounds.slice(1),
        ],
      }),
      'names unknown defect nope',
    ],
    [
      'transitions of unpublished findings',
      (run) => ({
        ...run,
        rounds: [
          observedRound(1, {
            transitions: [{ finding: 'zz', status: 'fixed' }],
          }),
          ...run.rounds.slice(1),
        ],
      }),
      'unpublished finding zz',
    ],
    [
      'funnel records for unknown defects',
      (run) => ({
        ...run,
        funnel: [
          ...run.funnel,
          { defect: 'nope', retrieved: true, discovered: true },
        ],
      }),
      'funnel names unknown defect nope',
    ],
    [
      'missing funnel records',
      (run) => ({ ...run, funnel: run.funnel.slice(1) }),
      'no record for divide',
    ],
    [
      'found but not discovered',
      (run) => ({
        ...run,
        funnel: [
          { defect: 'divide', retrieved: true, discovered: false },
          { defect: 'comment', retrieved: true, discovered: true },
        ],
      }),
      'was found, so it was retrieved and discovered',
    ],
  ];

  test.each(invalid)('refuses %s', (_name, change, message) => {
    expect(() => scoreRun(sample, change(perfectRun()), rates)).toThrow(
      message,
    );
  });
});

describe('scoreVariant', () => {
  const cleanRun = (run: number, falseFindings: number): RunObservation => ({
    history: 'clean',
    variant: 'delta',
    run,
    rounds: [
      observedRound(1, {
        published: Array.from({ length: falseFindings }, (_, index) => ({
          id: `c${index}`,
          severity: 'medium' as const,
          defect: null,
          causality: 'supported' as const,
        })),
      }),
    ],
    funnel: [],
  });

  test('averages repeated runs within a history before pooling', () => {
    const report = scoreVariant(
      [sample, clean],
      [
        perfectRun(1),
        noisyRun(2),
        cleanRun(1, 1),
        cleanRun(2, 0),
        perfectRun(1, 'control'),
      ],
      'delta',
      rates,
      { resamples: 500, allowPendingChecks: true },
    );
    expect(report.runs).toBe(4);
    expect(report.histories).toBe(2);
    // Sample: (2 + 2) / 2 true of (2 + 5) / 2 published; clean: 0 of 0.5.
    expect(report.precision.successes).toBeCloseTo(2, 12);
    expect(report.precision.trials).toBeCloseTo(4, 12);
    expect(report.precision.value).toBeCloseTo(0.5, 12);
    expect(report.precision.histories).toBe(2);
    expect(report.precision.interval?.lower).toBeLessThan(0.5);
    expect(report.precision.interval?.upper).toBeGreaterThan(0.5);
    expect(report.severeRecall.value).toBe(1);
    expect(report.retrievalMiss.value).toBe(0);
    expect(report.bucketRecall.get(6)?.value).toBeNull();
    expect(report.bucketRecall.get(6)?.interval).toBeNull();
    expect(report.cleanFalseFindingsPerPr.histories).toBe(1);
    // Sample: (0 + 2) / 2 false findings; clean: 0.5.
    expect(report.falseFindingsPerPr.value).toBeCloseTo(1.5 / 2, 12);
    expect(report.falseFindingsPerPr.histories).toBe(2);
    expect(report.severeRecallEndToEnd.value).toBe(0.5);
    // Sample: $4.25 over 3 rounds; clean: $2 over 1 round.
    expect(report.costPerRoundUsd.mean).toBeCloseTo((4.25 / 3 + 2) / 2, 12);
    expect(report.cleanFalseFindingsPerPr.value).toBe(0.5);
    expect(report.cleanFalseFindingsPerPr.interval?.lower).toBe(0);
    expect(report.cleanFalseFindingsPerPr.interval?.upper).toBeGreaterThan(5);
    expect(report.falseFixed).toBe(1);
    expect(report.dismissedResurfaced).toBe(0);
    expect(report.duplicates).toBe(1);
    expect(report.unexpectedInference).toBe(1);
    expect(report.funnel).toEqual({
      eligible: 2,
      available: 0,
      retrieved: 0,
      discovered: 0,
      published: 0,
      found: 4,
    });
    expect(report.usageComplete).toBe(false);
    expect(report.failedAttemptUsd).toBe(0.5);
    expect(report.researchUsd).toBe(0);
    expect(report.reviewerUsd).toBeCloseTo(4 + 4.5 + 2 + 2, 12);
    expect(report.costPerPrUsd.mean).toBeCloseTo((4.25 + 2) / 2, 12);
    expect(report.costPerPrUsd.median).toBeCloseTo(2, 12);
    expect(report.costPerPrUsd.p95).toBeCloseTo(4.25, 12);
    expect(report.latencyPerPrMs.median).toBe(1000);
    expect(report.cacheReadShare).toBeNull();
    expect(report.costPerDefectUsd).toBeCloseTo(12.5 / 4, 12);
  });

  test('reports no clean-PR rate without clean histories', () => {
    const report = scoreVariant([sample], [perfectRun()], 'delta', rates, {
      resamples: 100,
      allowPendingChecks: true,
    });
    expect(report.cleanFalseFindingsPerPr).toEqual({
      histories: 0,
      value: null,
      interval: null,
    });
    expect(report.usageComplete).toBe(true);
    expect(report.costPerDefectUsd).toBeCloseTo(2, 12);
  });

  test('refuses histories whose labels are not checked yet', () => {
    expect(() =>
      scoreVariant([sample], [perfectRun()], 'delta', rates),
    ).toThrow('Labels are not checked yet: sample.');
    const json = sampleHistory();
    json.labels['check'] = {
      status: 'confirmed',
      by: 'checker-b',
      on: '2026-10-20',
      notes: 'Agreed.',
    };
    const checked = parseHistory(json);
    expect(
      scoreVariant([checked], [perfectRun()], 'delta', rates, { resamples: 10 })
        .precision.value,
    ).toBe(1);
  });

  test('refuses an incomplete or inconsistent set of runs', () => {
    const pending = { allowPendingChecks: true };
    expect(() => scoreVariant([], [], 'delta', rates)).toThrow(
      'The corpus is empty',
    );
    expect(() =>
      scoreVariant([sample, clean], [perfectRun()], 'delta', rates, pending),
    ).toThrow('Variant delta has no run of clean');
    expect(() =>
      scoreVariant(
        [sample],
        [perfectRun(1), perfectRun(1)],
        'delta',
        rates,
        pending,
      ),
    ).toThrow('is recorded twice');
    expect(() =>
      scoreVariant(
        [sample],
        [perfectRun(), cleanRun(1, 0)],
        'delta',
        rates,
        pending,
      ),
    ).toThrow('names a history outside the corpus');
  });
});

describe('pairedLossUpperBound', () => {
  test('is about 3/n with no observed losses', () => {
    expect(pairedLossUpperBound(0, 100)).toBeCloseTo(0.0295, 4);
    expect(pairedLossUpperBound(0, 30)).toBeGreaterThan(0.09);
    expect(pairedLossUpperBound(2, 100)).toBeGreaterThan(
      pairedLossUpperBound(0, 100),
    );
  });
});
