// Scoring of observed runs against labeled histories, as evals/protocol.md
// defines each metric. A run is one variant reviewing every round of one
// history once. A person adjudicates each published finding (which defect it
// matches, if any, and whether its `introducedBy` supports the causal claim)
// before the run is scored; this module never matches findings itself.
//
// Histories are the unit of uncertainty. Repeated runs of one history are
// averaged first and never count as independent examples.
import type {
  DefectLabel,
  ExpectedRound,
  LabeledHistory,
  SourceRound,
  TransitionStatus,
} from './history.ts';
import type { Severity } from '../../src/shared/severity.ts';
import {
  costLedger,
  costPerDefect,
  cacheReadShare,
  type CostLedger,
  type Rates,
  type RequestRecord,
} from './cost.ts';
import {
  binomialUpperBound,
  clopperPearson,
  clusterBootstrap,
  poissonRateInterval,
  quantile,
  union,
  type BootstrapOptions,
  type Interval,
} from './intervals.ts';

export interface PublishedFinding {
  readonly id: string;
  readonly severity: Severity;
  // The labeled defect the adjudicator matched, or null.
  readonly defect: string | null;
  // `unrelated` when `introducedBy` cites a structurally valid but unrelated
  // changed line; such a finding is false even when it matches a defect.
  readonly causality: 'supported' | 'unrelated';
}

export interface ObservedTransition {
  readonly finding: string;
  readonly status: TransitionStatus | 'reopened';
}

export interface ObservedRound {
  readonly round: number;
  readonly requests: readonly RequestRecord[];
  readonly latencyMs: number;
  readonly published: readonly PublishedFinding[];
  readonly transitions: readonly ObservedTransition[];
}

// Whether the required evidence reached the prompt, and whether any raw
// candidate matched the defect before validation.
export interface FunnelObservation {
  readonly defect: string;
  readonly retrieved: boolean;
  readonly discovered: boolean;
}

export interface RunObservation {
  readonly history: string;
  readonly variant: string;
  readonly run: number;
  readonly rounds: readonly ObservedRound[];
  readonly funnel: readonly FunnelObservation[];
}

export const funnelStages = [
  'eligible',
  'available',
  'retrieved',
  'discovered',
  'published',
] as const;
export type FunnelStage = (typeof funnelStages)[number];

// The R2+, R6+ and R12+ buckets.
export const roundBuckets = [2, 6, 12] as const;

interface Ratio {
  successes: number;
  trials: number;
}

export interface RunScore {
  readonly history: string;
  readonly clean: boolean;
  readonly precision: Ratio;
  readonly severePrecision: Ratio;
  readonly severeRecall: Ratio;
  readonly retrievalMiss: Ratio;
  readonly bucketRecall: ReadonlyMap<number, Ratio>;
  readonly falseFindings: number;
  readonly duplicates: number;
  readonly falseFixed: number;
  readonly dismissedResurfaced: number;
  readonly unexpectedInference: number;
  readonly defectsFound: number;
  // Where each labeled defect left the funnel; null when it was published.
  readonly funnel: ReadonlyMap<string, FunnelStage | null>;
  readonly cost: CostLedger;
  readonly latencyMs: number;
}

const severe = (severity: Severity): boolean =>
  severity === 'high' || severity === 'critical';

const present = (defect: DefectLabel, round: number): boolean =>
  defect.introducedRound <= round &&
  (defect.fixedRound === null || round < defect.fixedRound);

const counted = (defect: DefectLabel): boolean =>
  defect.eligible && defect.available;

function fail(run: RunObservation, message: string): never {
  throw new RangeError(
    `Run ${run.run} of ${run.variant} on ${run.history}: ${message}`,
  );
}

export function scoreRun(
  history: LabeledHistory,
  run: RunObservation,
  rates: Rates,
): RunScore {
  if (run.history !== history.id) fail(run, `is not a run of ${history.id}`);
  const defects = new Map(
    history.labels.defects.map((defect) => [defect.id, defect]),
  );
  const rounds = history.source.rounds;
  if (run.rounds.length !== rounds.length) {
    fail(run, `must observe all ${rounds.length} rounds`);
  }

  const precision: Ratio = { successes: 0, trials: 0 };
  const severePrecision: Ratio = { successes: 0, trials: 0 };
  const findings = new Map<string, PublishedFinding>();
  const credited = new Set<string>();
  let falseFindings = 0;
  let duplicates = 0;
  let falseFixed = 0;
  let dismissedResurfaced = 0;
  let unexpectedInference = 0;
  let latencyMs = 0;
  const requests: RequestRecord[] = [];
  const dismissedAt = new Map<string, number>();

  run.rounds.forEach((observed, index) => {
    const number = index + 1;
    if (observed.round !== number)
      fail(run, `round ${index} must be ${number}`);
    if (!(observed.latencyMs >= 0))
      fail(run, `round ${number} latency is invalid`);
    latencyMs += observed.latencyMs;
    requests.push(...observed.requests);
    for (const action of (rounds[index] as SourceRound).actions) {
      if (!dismissedAt.has(action.defect))
        dismissedAt.set(action.defect, number);
    }
    const expected = history.expected[index] as ExpectedRound;
    const sent = observed.requests.filter(
      (request) =>
        request.purpose !== 'research' && request.outcome !== 'refused-budget',
    );
    if (!expected.inference && sent.length > 0) {
      unexpectedInference += 1;
    }

    for (const finding of observed.published) {
      if (findings.has(finding.id)) fail(run, `finding ${finding.id} repeats`);
      findings.set(finding.id, finding);
      const defect =
        finding.defect === null ? undefined : defects.get(finding.defect);
      if (finding.defect !== null && defect === undefined) {
        fail(
          run,
          `finding ${finding.id} names unknown defect ${finding.defect}`,
        );
      }
      if (defect !== undefined) {
        const dismissed = dismissedAt.get(defect.id);
        if (dismissed !== undefined && number >= dismissed) {
          dismissedResurfaced += 1;
        }
      }
      const matches =
        defect !== undefined &&
        finding.causality === 'supported' &&
        present(defect, number);
      let truth = false;
      if (matches && credited.has(defect.id)) duplicates += 1;
      else if (matches) {
        credited.add(defect.id);
        truth = true;
      } else falseFindings += 1;
      precision.trials += 1;
      if (truth) precision.successes += 1;
      if (severe(finding.severity)) {
        severePrecision.trials += 1;
        if (truth) severePrecision.successes += 1;
      }
    }

    for (const transition of observed.transitions) {
      const finding = findings.get(transition.finding);
      if (finding === undefined) {
        fail(run, `transition names unpublished finding ${transition.finding}`);
      }
      const defect =
        finding.defect === null ? undefined : defects.get(finding.defect);
      if (
        transition.status === 'fixed' &&
        defect !== undefined &&
        finding.causality === 'supported' &&
        present(defect, number)
      ) {
        falseFixed += 1;
      }
    }
  });

  const funnelRecords = new Map(
    run.funnel.map((entry) => [entry.defect, entry]),
  );
  for (const id of funnelRecords.keys()) {
    if (!defects.has(id)) fail(run, `funnel names unknown defect ${id}`);
  }
  const funnel = new Map<string, FunnelStage | null>();
  const severeRecall: Ratio = { successes: 0, trials: 0 };
  const retrievalMiss: Ratio = { successes: 0, trials: 0 };
  const bucketRecall = new Map<number, Ratio>(
    roundBuckets.map((bucket) => [bucket, { successes: 0, trials: 0 }]),
  );
  for (const defect of defects.values()) {
    const found = credited.has(defect.id);
    if (!counted(defect)) {
      funnel.set(defect.id, defect.eligible ? 'available' : 'eligible');
      continue;
    }
    const record = funnelRecords.get(defect.id);
    if (record === undefined)
      fail(run, `funnel has no record for ${defect.id}`);
    if (found && !(record.retrieved && record.discovered)) {
      fail(run, `${defect.id} was found, so it was retrieved and discovered`);
    }
    funnel.set(
      defect.id,
      !record.retrieved
        ? 'retrieved'
        : !record.discovered
          ? 'discovered'
          : found
            ? null
            : 'published',
    );
    if (!severe(defect.severity)) continue;
    severeRecall.trials += 1;
    retrievalMiss.trials += 1;
    if (found) severeRecall.successes += 1;
    if (!record.retrieved) retrievalMiss.successes += 1;
    for (const [bucket, ratio] of bucketRecall) {
      if (defect.introducedRound < bucket) continue;
      ratio.trials += 1;
      if (found) ratio.successes += 1;
    }
  }

  return {
    history: history.id,
    clean: defects.size === 0,
    precision,
    severePrecision,
    severeRecall,
    retrievalMiss,
    bucketRecall,
    falseFindings,
    duplicates,
    falseFixed,
    dismissedResurfaced,
    unexpectedInference,
    defectsFound: credited.size,
    funnel,
    cost: costLedger(requests, rates),
    latencyMs,
  };
}

// --- Aggregation across histories. ---

export interface ProportionEstimate {
  // Sums of run-averaged counts, so they can be fractional with repeats.
  readonly successes: number;
  readonly trials: number;
  readonly value: number | null;
  // Union of Clopper-Pearson on the averaged counts, rounded outward, and
  // the history-cluster bootstrap. null with no trials.
  readonly interval: Interval | null;
  // Histories that contribute at least one trial.
  readonly histories: number;
}

export interface Distribution {
  readonly mean: number;
  readonly meanInterval: Interval | null;
  readonly median: number;
  readonly p95: number;
}

export interface VariantReport {
  readonly variant: string;
  readonly histories: number;
  readonly runs: number;
  readonly precision: ProportionEstimate;
  readonly severePrecision: ProportionEstimate;
  readonly severeRecall: ProportionEstimate;
  readonly retrievalMiss: ProportionEstimate;
  readonly bucketRecall: ReadonlyMap<number, ProportionEstimate>;
  readonly cleanFalseFindingsPerPr: {
    readonly cleanHistories: number;
    readonly value: number | null;
    readonly interval: Interval | null;
  };
  // Totals over every run; each is gated at zero.
  readonly falseFixed: number;
  readonly dismissedResurfaced: number;
  readonly duplicates: number;
  readonly unexpectedInference: number;
  // Defect-runs that left the funnel at each stage; `published` is lost at
  // the last step, and `found` reached it.
  readonly funnel: Readonly<Record<FunnelStage | 'found', number>>;
  readonly costPerPrUsd: Distribution;
  readonly latencyPerPrMs: Distribution;
  readonly reviewerUsd: number;
  readonly failedAttemptUsd: number;
  readonly researchUsd: number;
  readonly usageComplete: boolean;
  readonly cacheReadShare: number | null;
  readonly costPerDefectUsd: number | null;
}

interface HistoryRatio {
  successes: number;
  trials: number;
}

function proportion(
  perHistory: readonly HistoryRatio[],
  options: BootstrapOptions,
): ProportionEstimate {
  const contributing = perHistory.filter((entry) => entry.trials > 0);
  const total = (sample: readonly HistoryRatio[]): HistoryRatio =>
    sample.reduce(
      (sum, entry) => ({
        successes: sum.successes + entry.successes,
        trials: sum.trials + entry.trials,
      }),
      { successes: 0, trials: 0 },
    );
  const { successes, trials } = total(contributing);
  if (trials === 0) {
    return { successes, trials, value: null, interval: null, histories: 0 };
  }
  const n = Math.ceil(trials - 1e-9);
  const low = Math.min(Math.floor(successes + 1e-9), n);
  const high = Math.min(Math.ceil(successes - 1e-9), n);
  const exact = {
    lower: clopperPearson(low, n).lower,
    upper: clopperPearson(high, Math.max(high, Math.floor(trials + 1e-9)))
      .upper,
  };
  const bootstrap = clusterBootstrap(
    contributing,
    (sample) => {
      const sum = total(sample);
      return sum.trials === 0 ? null : sum.successes / sum.trials;
    },
    options,
  );
  return {
    successes,
    trials,
    value: successes / trials,
    interval: union(exact, bootstrap),
    histories: contributing.length,
  };
}

function distribution(
  values: readonly number[],
  options: BootstrapOptions,
): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = (sample: readonly number[]): number =>
    sample.reduce((sum, value) => sum + value, 0) / sample.length;
  return {
    mean: mean(values),
    meanInterval: clusterBootstrap(values, mean, options),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function averageRatio(ratios: readonly Ratio[]): HistoryRatio {
  return {
    successes: average(ratios.map((ratio) => ratio.successes)),
    trials: average(ratios.map((ratio) => ratio.trials)),
  };
}

// Scores every run of one variant. The variant must have at least one run
// of every history, so leaving out a hard history cannot raise a score.
export function scoreVariant(
  histories: readonly LabeledHistory[],
  runs: readonly RunObservation[],
  variant: string,
  rates: Rates,
  options: BootstrapOptions = {},
): VariantReport {
  if (histories.length === 0) throw new RangeError('The corpus is empty.');
  const selected = runs.filter((run) => run.variant === variant);
  const seen = new Set<string>();
  for (const run of selected) {
    const key = `${run.history}#${run.run}`;
    if (seen.has(key)) fail(run, 'is recorded twice');
    seen.add(key);
  }
  const byHistory = histories.map((history) => {
    const scores = selected
      .filter((run) => run.history === history.id)
      .map((run) => scoreRun(history, run, rates));
    if (scores.length === 0) {
      throw new RangeError(`Variant ${variant} has no run of ${history.id}.`);
    }
    return scores;
  });
  const known = new Set(histories.map((history) => history.id));
  for (const run of selected) {
    if (!known.has(run.history))
      fail(run, 'names a history outside the corpus');
  }

  const ratio = (pick: (score: RunScore) => Ratio): ProportionEstimate =>
    proportion(
      byHistory.map((scores) => averageRatio(scores.map(pick))),
      options,
    );
  const sum = (pick: (score: RunScore) => number): number =>
    byHistory.flat().reduce((total, score) => total + pick(score), 0);

  const clean = byHistory
    .filter((scores) => (scores[0] as RunScore).clean)
    .map((scores) => average(scores.map((score) => score.falseFindings)));
  const cleanTotal = clean.reduce((total, value) => total + value, 0);
  const cleanFalseFindingsPerPr =
    clean.length === 0
      ? { cleanHistories: 0, value: null, interval: null }
      : {
          cleanHistories: clean.length,
          value: cleanTotal / clean.length,
          interval: union(
            {
              lower: poissonRateInterval(
                Math.floor(cleanTotal + 1e-9),
                clean.length,
              ).lower,
              upper: poissonRateInterval(
                Math.ceil(cleanTotal - 1e-9),
                clean.length,
              ).upper,
            },
            clusterBootstrap(clean, average, options),
          ),
        };

  const funnel: Record<FunnelStage | 'found', number> = {
    eligible: 0,
    available: 0,
    retrieved: 0,
    discovered: 0,
    published: 0,
    found: 0,
  };
  for (const score of byHistory.flat()) {
    for (const stage of score.funnel.values()) funnel[stage ?? 'found'] += 1;
  }

  const ledgers = byHistory.flat().map((score) => score.cost);
  const pooled = {
    cachedInputTokens: ledgers.reduce((t, l) => t + l.cachedInputTokens, 0),
    cacheWriteTokens: ledgers.reduce((t, l) => t + l.cacheWriteTokens, 0),
  };
  const reviewerUsd = sum((score) => score.cost.reviewerUsd);

  return {
    variant,
    histories: histories.length,
    runs: selected.length,
    precision: ratio((score) => score.precision),
    severePrecision: ratio((score) => score.severePrecision),
    severeRecall: ratio((score) => score.severeRecall),
    retrievalMiss: ratio((score) => score.retrievalMiss),
    bucketRecall: new Map(
      roundBuckets.map((bucket) => [
        bucket,
        ratio((score) => score.bucketRecall.get(bucket) as Ratio),
      ]),
    ),
    cleanFalseFindingsPerPr,
    falseFixed: sum((score) => score.falseFixed),
    dismissedResurfaced: sum((score) => score.dismissedResurfaced),
    duplicates: sum((score) => score.duplicates),
    unexpectedInference: sum((score) => score.unexpectedInference),
    funnel,
    costPerPrUsd: distribution(
      byHistory.map((scores) => average(scores.map((s) => s.cost.reviewerUsd))),
      options,
    ),
    latencyPerPrMs: distribution(
      byHistory.map((scores) => average(scores.map((s) => s.latencyMs))),
      options,
    ),
    reviewerUsd,
    failedAttemptUsd: sum((score) => score.cost.failedAttemptUsd),
    researchUsd: sum((score) => score.cost.researchUsd),
    usageComplete: ledgers.every((ledger) => ledger.usageComplete),
    cacheReadShare: cacheReadShare(pooled),
    costPerDefectUsd: costPerDefect(
      reviewerUsd,
      sum((s) => s.defectsFound),
    ),
  };
}

// One-sided upper bound on paired recall loss against a control: the exact
// binomial bound on the share of paired cases the control found and the
// variant missed. Gains elsewhere are not netted against losses, so the
// bound is conservative. With no losses it is about 3/n at 95%.
export function pairedLossUpperBound(
  losses: number,
  pairs: number,
  confidence?: number,
): number {
  return binomialUpperBound(losses, pairs, confidence);
}
