/** Small seeded generator, so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] as number;
  return sum / values.length;
}

/** Population standard deviation. */
export function stddev(values: ArrayLike<number>): number {
  if (values.length === 0) return NaN;
  const m = mean(values);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += ((values[i] as number) - m) ** 2;
  return Math.sqrt(sum / values.length);
}

/** Quantile of an ascending array, with linear interpolation. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const a = sorted[low] as number;
  const b = sorted[high] as number;
  return a + (b - a) * (position - low);
}

export function median(values: number[]): number {
  return quantileSorted([...values].sort((a, b) => a - b), 0.5);
}

export interface BootstrapOptions {
  /** Default 2000. */
  resamples?: number;
  /** Default 1. */
  seed?: number;
  /** Default 0.95. */
  level?: number;
}

export interface Interval {
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

/**
 * Percentile bootstrap interval for the mean: resample the values with
 * replacement, take the mean of each resample, and read the interval from the
 * distribution of those means.
 */
export function bootstrapMeanCI(values: number[], options: BootstrapOptions = {}): Interval {
  const n = values.length;
  if (n === 0) return { n, mean: NaN, lo: NaN, hi: NaN };
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const random = mulberry32(options.seed ?? 1);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(random() * n)] as number;
    means[r] = sum / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  return { n, mean: mean(values), lo: quantileSorted(means, tail), hi: quantileSorted(means, 1 - tail) };
}

export interface PairedComparison {
  n: number;
  wins: number;
  losses: number;
  ties: number;
  meanA: number;
  meanB: number;
  /** Mean of a minus b over the paired cases, with its bootstrap interval. */
  diff: Interval;
}

/**
 * Paired comparison of two score lists over the same cases, in the same order.
 * Cases are resampled as pairs, which keeps the per-case correlation between
 * the two methods and gives a tighter interval than comparing two separate means.
 */
export function pairedComparison(a: number[], b: number[], options: BootstrapOptions = {}): PairedComparison {
  if (a.length !== b.length) throw new Error("paired comparison needs two lists of equal length");
  const diffs = a.map((value, i) => value - (b[i] as number));
  return {
    n: a.length,
    wins: diffs.filter((d) => d > 0).length,
    losses: diffs.filter((d) => d < 0).length,
    ties: diffs.filter((d) => d === 0).length,
    meanA: mean(a),
    meanB: mean(b),
    diff: bootstrapMeanCI(diffs, options),
  };
}
