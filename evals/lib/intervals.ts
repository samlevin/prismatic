// The interval methods evals/protocol.md names. All are deterministic: the
// exact intervals by bisection on the binomial and Poisson distributions, and
// the bootstrap from a seeded generator, so a report reproduces bit for bit.

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

export const defaultConfidence = 0.95;
export const bootstrapResamples = 10_000;
export const bootstrapSeed = 20_261_019;

function checkConfidence(confidence: number): void {
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError('Confidence must be between 0 and 1.');
  }
}

function checkCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}

// P(X <= k) for X ~ Binomial(n, p), summed in log space so large n does not
// underflow.
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n || p <= 0) return 1;
  if (p >= 1) return 0;
  let log = n * Math.log1p(-p);
  let total = Math.exp(log);
  const ratio = Math.log(p) - Math.log1p(-p);
  for (let i = 0; i < k; i += 1) {
    log += Math.log(n - i) - Math.log(i + 1) + ratio;
    total += Math.exp(log);
  }
  return Math.min(1, total);
}

// P(X <= k) for X ~ Poisson(mean).
export function poissonCdf(k: number, mean: number): number {
  if (k < 0) return 0;
  if (mean <= 0) return 1;
  let log = -mean;
  let total = Math.exp(log);
  for (let i = 1; i <= k; i += 1) {
    log += Math.log(mean) - Math.log(i);
    total += Math.exp(log);
  }
  return Math.min(1, total);
}

// The x in [low, high] where a decreasing function crosses the target.
function solveDecreasing(
  f: (x: number) => number,
  target: number,
  low: number,
  high: number,
): number {
  let a = low;
  let b = high;
  for (let i = 0; i < 200 && b - a > 1e-12 * Math.max(1, b); i += 1) {
    const middle = (a + b) / 2;
    if (f(middle) > target) a = middle;
    else b = middle;
  }
  return (a + b) / 2;
}

// Exact one-sided upper bound on a binomial proportion: the p at which
// observing k or fewer successes has probability 1 - confidence. With k = 0
// it is 1 - (1 - confidence)^(1/n), about 3/n at 95%.
export function binomialUpperBound(
  k: number,
  n: number,
  confidence = defaultConfidence,
): number {
  checkCount(k, 'Successes');
  checkCount(n, 'Trials');
  checkConfidence(confidence);
  if (k > n) throw new RangeError('Successes cannot exceed trials.');
  if (n === 0 || k === n) return 1;
  return solveDecreasing((p) => binomialCdf(k, n, p), 1 - confidence, 0, 1);
}

// Exact one-sided lower bound, by symmetry with the upper bound.
export function binomialLowerBound(
  k: number,
  n: number,
  confidence = defaultConfidence,
): number {
  checkCount(k, 'Successes');
  checkCount(n, 'Trials');
  if (k > n) throw new RangeError('Successes cannot exceed trials.');
  return 1 - binomialUpperBound(n - k, n, confidence);
}

// Two-sided Clopper-Pearson interval.
export function clopperPearson(
  k: number,
  n: number,
  confidence = defaultConfidence,
): Interval {
  checkConfidence(confidence);
  const tail = 1 - (1 - confidence) / 2;
  return {
    lower: binomialLowerBound(k, n, tail),
    upper: binomialUpperBound(k, n, tail),
  };
}

// Two-sided exact (Garwood) interval for a Poisson count, divided by the
// exposure, such as the number of clean pull requests.
export function poissonRateInterval(
  count: number,
  exposure: number,
  confidence = defaultConfidence,
): Interval {
  checkCount(count, 'Count');
  checkConfidence(confidence);
  if (!(exposure > 0)) throw new RangeError('Exposure must be positive.');
  const alpha = (1 - confidence) / 2;
  // Large enough that P(X <= count) is below alpha for any count we score.
  const ceiling = 10 * (count + 10);
  const lower =
    count === 0
      ? 0
      : // P(X >= count) = alpha, that is P(X <= count - 1) = 1 - alpha.
        solveDecreasing(
          (mean) => poissonCdf(count - 1, mean),
          1 - alpha,
          0,
          ceiling,
        );
  const upper = solveDecreasing(
    (mean) => poissonCdf(count, mean),
    alpha,
    0,
    ceiling,
  );
  return { lower: lower / exposure, upper: upper / exposure };
}

// mulberry32: a small seeded generator, good enough for resampling.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Nearest-rank quantile of the sorted values.
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new RangeError('No values.');
  if (!(q >= 0 && q <= 1)) throw new RangeError('Quantile must be in [0, 1].');
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

export interface BootstrapOptions {
  readonly confidence?: number;
  readonly resamples?: number;
  readonly seed?: number;
}

// Percentile bootstrap over clusters (histories). Each resample draws as
// many clusters as there are, with replacement, and keeps everything inside
// a drawn cluster together, so items from one history never count as
// independent. `statistic` returns null when a resample has no denominator;
// those resamples are skipped. Returns null when every resample is skipped.
export function clusterBootstrap<T>(
  clusters: readonly T[],
  statistic: (sample: readonly T[]) => number | null,
  options: BootstrapOptions = {},
): Interval | null {
  const confidence = options.confidence ?? defaultConfidence;
  const resamples = options.resamples ?? bootstrapResamples;
  checkConfidence(confidence);
  if (clusters.length === 0) return null;
  const random = seededRandom(options.seed ?? bootstrapSeed);
  const values: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const sample: T[] = [];
    for (let i = 0; i < clusters.length; i += 1) {
      sample.push(clusters[Math.floor(random() * clusters.length)] as T);
    }
    const value = statistic(sample);
    if (value !== null) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return { lower: quantile(values, alpha), upper: quantile(values, 1 - alpha) };
}

// The smallest interval containing both, or the one that exists.
export function union(a: Interval | null, b: Interval | null): Interval | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    lower: Math.min(a.lower, b.lower),
    upper: Math.max(a.upper, b.upper),
  };
}
