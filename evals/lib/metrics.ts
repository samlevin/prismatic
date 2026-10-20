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
  // Over every severe defect, including ineligible and unavailable ones.
  readonly severeRecallEndToEnd: Ratio;
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
  readonly rounds: number;
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
  // Round of the first finding matched to each defect, whatever its
  // causality, and the round in which the author dismissed a defect this run
  // had published. The author dismisses whatever finding they were shown.
  const firstPublished = new Map<string, number>();
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
      const published = firstPublished.get(action.defect);
      if (published !== undefined && !dismissedAt.has(action.defect)) {
        dismissedAt.set(action.defect, number);
      }
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
      if (defect !== undefined && dismissedAt.has(defect.id)) {
        dismissedResurfaced += 1;
      }
      if (defect !== undefined && !firstPublished.has(defect.id)) {
        firstPublished.set(defect.id, number);
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
  const severeRecallEndToEnd: Ratio = { successes: 0, trials: 0 };
  const retrievalMiss: Ratio = { successes: 0, trials: 0 };
  const bucketRecall = new Map<number, Ratio>(
    roundBuckets.map((bucket) => [bucket, { successes: 0, trials: 0 }]),
  );
  for (const defect of defects.values()) {
    const found = credited.has(defect.id);
    if (severe(defect.severity)) {
      severeRecallEndToEnd.trials += 1;
      if (found) severeRecallEndToEnd.successes += 1;
    }
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
    severeRecallEndToEnd,
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
    rounds: rounds.length,
    latencyMs,
  };
}

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

export interface RateEstimate {
  readonly histories: number;
  // Sum of run-averaged event counts over those histories.
  readonly total: number;
  readonly value: number | null;
  // Union of the exact Poisson interval on the averaged total, rounded
  // outward, and the history-cluster bootstrap. null with no histories.
  readonly interval: Interval | null;
}

export interface ScoreOptions extends BootstrapOptions {
  // Score histories whose second label check is still pending. Only
  // for runs that find implementation problems, such as the P0.12 pilot;
  // never for a reported quality result.
  readonly allowPendingChecks?: boolean;
}

export interface Distribution {
  readonly histories: number;
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
  readonly severeRecallEndToEnd: ProportionEstimate;
  readonly retrievalMiss: ProportionEstimate;
  readonly bucketRecall: ReadonlyMap<number, ProportionEstimate>;
  // False findings per PR over every history, and over clean histories.
  readonly falseFindingsPerPr: RateEstimate;
  readonly cleanFalseFindingsPerPr: RateEstimate;
  // Totals over every run; each is gated at zero.
  readonly falseFixed: number;
  readonly dismissedResurfaced: number;
  readonly duplicates: number;
  readonly unexpectedInference: number;
  // Defect-runs that left the funnel at each stage; `published` is lost at
  // the last step, and `found` reached it.
  readonly funnel: Readonly<Record<FunnelStage | 'found', number>>;
  readonly costPerPrUsd: Distribution;
  readonly costPerRoundUsd: Distribution;
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
    lower: clopperPearson(low, n, options.confidence).lower,
    upper: clopperPearson(
      high,
      Math.max(high, Math.floor(trials + 1e-9)),
      options.confidence,
    ).upper,
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

// Mean events per history, such as false findings per PR.
function rate(
  perHistory: readonly number[],
  options: BootstrapOptions,
): RateEstimate {
  if (perHistory.length === 0) {
    return { histories: 0, total: 0, value: null, interval: null };
  }
  const total = perHistory.reduce((sum, value) => sum + value, 0);
  const n = perHistory.length;
  return {
    histories: n,
    total,
    value: total / n,
    interval: union(
      {
        lower: poissonRateInterval(
          Math.floor(total + 1e-9),
          n,
          options.confidence,
        ).lower,
        upper: poissonRateInterval(
          Math.ceil(total - 1e-9),
          n,
          options.confidence,
        ).upper,
      },
      clusterBootstrap(perHistory, average, options),
    ),
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
    histories: values.length,
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
  options: ScoreOptions = {},
): VariantReport {
  if (histories.length === 0) throw new RangeError('The corpus is empty.');
  if (!options.allowPendingChecks) {
    const pending = histories.filter(
      (history) => history.labels.check.status === 'pending',
    );
    if (pending.length > 0) {
      throw new RangeError(
        `Labels are not checked yet: ${pending.map((h) => h.id).join(', ')}.`,
      );
    }
  }
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

  const falseFindings = byHistory.map((scores) =>
    average(scores.map((score) => score.falseFindings)),
  );
  const cleanFalseFindings = falseFindings.filter(
    (_, index) => (byHistory[index]?.[0] as RunScore).clean,
  );

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
    severeRecallEndToEnd: ratio((score) => score.severeRecallEndToEnd),
    retrievalMiss: ratio((score) => score.retrievalMiss),
    bucketRecall: new Map(
      roundBuckets.map((bucket) => [
        bucket,
        ratio((score) => score.bucketRecall.get(bucket) as Ratio),
      ]),
    ),
    falseFindingsPerPr: rate(falseFindings, options),
    cleanFalseFindingsPerPr: rate(cleanFalseFindings, options),
    falseFixed: sum((score) => score.falseFixed),
    dismissedResurfaced: sum((score) => score.dismissedResurfaced),
    duplicates: sum((score) => score.duplicates),
    unexpectedInference: sum((score) => score.unexpectedInference),
    funnel,
    costPerPrUsd: distribution(
      byHistory.map((scores) => average(scores.map((s) => s.cost.reviewerUsd))),
      options,
    ),
    costPerRoundUsd: distribution(
      byHistory.map((scores) =>
        average(scores.map((s) => s.cost.reviewerUsd / s.rounds)),
      ),
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
