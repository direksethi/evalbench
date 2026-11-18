import type { Case } from "./cases.ts";
import { methodFileHash } from "./methods.ts";
import { mapLimit } from "./pool.ts";
import { isFresh, latencyOf, listResultMethods, readResult, type ResultRecord } from "./results.ts";
import { selectCases } from "./runner.ts";
import type { Scorer } from "./scorers/types.ts";
import { SPLITS, type Split } from "./split.ts";
import {
  bootstrapMeanCI, mean, pairedComparison, stddev,
  type BootstrapOptions, type PairedComparison,
} from "./stats.ts";

export interface Project {
  casesDir: string;
  methodsDir: string;
  scorersDir: string;
  resultsDir: string;
}

interface Loaded {
  c: Case;
  record: ResultRecord;
}

interface MethodResults {
  method: string;
  fresh: Loaded[];
  stale: number;
}

async function loadMethodResults(project: Project, method: string, cases: Case[]): Promise<MethodResults> {
  const methodHash = await methodFileHash(project.methodsDir, method);
  const loaded: MethodResults = { method, fresh: [], stale: 0 };
  for (const c of cases) {
    const record = await readResult(project.resultsDir, method, c.id);
    if (!record) continue;
    if (isFresh(record, c, methodHash)) loaded.fresh.push({ c, record });
    else loaded.stale++;
  }
  return loaded;
}

/**
 * Score of one result under a scorer. A failed run counts as 0 and a fail, so a
 * method cannot look better by crashing on hard cases. Null means the result
 * has not been scored with this scorer.
 */
function scoreOf(record: ResultRecord, scorer: string): { score: number; pass: boolean } | null {
  if (record.status === "error") return { score: 0, pass: false };
  const entry = record.scores[scorer];
  if (!entry || entry.score === null) return null;
  return { score: entry.score, pass: entry.pass === true };
}

/** The scorer to report on: the one asked for, or the only one present in the results. */
function pickScorer(all: MethodResults[], requested: string | undefined): string {
  if (requested) return requested;
  const names = new Set<string>();
  for (const m of all) for (const { record } of m.fresh) for (const name of Object.keys(record.scores)) names.add(name);
  if (names.size === 1) return [...names][0] as string;
  if (names.size === 0) throw new Error("no scores found: run `evalbench score <method>` first");
  throw new Error(`results hold several scorers (${[...names].sort().join(", ")}): choose one with --scorer`);
}

export interface LeaderboardRow {
  method: string;
  split: Split;
  /** Cases that enter the mean: scored results plus failed runs. */
  n: number;
  mean: number;
  lo: number;
  hi: number;
  passRate: number;
  /** Over successful runs. */
  meanLatencyMs: number;
  /** Null when no result reported a cost. */
  totalCostUsd: number | null;
  ok: number;
  errors: number;
  /** Cases in the split. */
  total: number;
  unscored: number;
}

export interface Leaderboard {
  scorer: string;
  rows: LeaderboardRow[];
  /** Results ignored because the method file or the case changed since they were produced. */
  stale: { method: string; count: number }[];
}

export interface ReportOptions extends BootstrapOptions {
  scorer?: string;
  split?: Split;
}

export async function buildLeaderboard(
  project: Project,
  cases: Case[],
  options: ReportOptions = {},
): Promise<Leaderboard> {
  const methods = await listResultMethods(project.resultsDir);
  if (methods.length === 0) throw new Error(`no results in ${project.resultsDir}: run a method first`);
  const all: MethodResults[] = [];
  for (const method of methods) all.push(await loadMethodResults(project, method, cases));
  const scorer = pickScorer(all, options.scorer);

  const rows: LeaderboardRow[] = [];
  for (const split of options.split ? [options.split] : SPLITS) {
    const total = cases.filter((c) => c.split === split).length;
    for (const m of all) {
      const items = m.fresh.filter((item) => item.c.split === split);
      if (items.length === 0) continue;
      const scores: number[] = [];
      let passes = 0;
      let unscored = 0;
      for (const { record } of items) {
        const s = scoreOf(record, scorer);
        if (!s) unscored++;
        else {
          scores.push(s.score);
          if (s.pass) passes++;
        }
      }
      const okRecords = items.filter((item) => item.record.status === "ok").map((item) => item.record);
      const costs = okRecords.map((r) => r.usage?.costUsd).filter((v): v is number => v !== undefined);
      const interval = bootstrapMeanCI(scores, options);
      rows.push({
        method: m.method,
        split,
        n: scores.length,
        mean: interval.mean,
        lo: interval.lo,
        hi: interval.hi,
        passRate: scores.length ? passes / scores.length : NaN,
        meanLatencyMs: mean(okRecords.map(latencyOf)),
        totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
        ok: okRecords.length,
        errors: items.length - okRecords.length,
        total,
        unscored,
      });
    }
  }
  const order = (row: LeaderboardRow) => (Number.isNaN(row.mean) ? -Infinity : row.mean);
  rows.sort((a, b) => SPLITS.indexOf(a.split) - SPLITS.indexOf(b.split) || order(b) - order(a) || a.method.localeCompare(b.method));
  const stale = all.filter((m) => m.stale > 0).map((m) => ({ method: m.method, count: m.stale }));
  return { scorer, rows, stale };
}

export interface CaseDifference {
  caseId: string;
  a: number;
  b: number;
}

export interface Comparison {
  scorer: string;
  a: string;
  b: string;
  splits: { split: Split; result: PairedComparison; differences: CaseDifference[]; unpaired: number }[];
}

/** Paired comparison over the cases both methods have a fresh, scored result for. */
export async function buildComparison(
  project: Project,
  cases: Case[],
  a: string,
  b: string,
  options: ReportOptions = {},
): Promise<Comparison> {
  const known = await listResultMethods(project.resultsDir);
  for (const name of [a, b]) {
    if (!known.includes(name)) throw new Error(`no results for method "${name}"`);
  }
  const resultsA = await loadMethodResults(project, a, cases);
  const resultsB = await loadMethodResults(project, b, cases);
  const scorer = pickScorer([resultsA, resultsB], options.scorer);
  const byCase = (m: MethodResults) => new Map(m.fresh.map((item) => [item.c.id, scoreOf(item.record, scorer)]));
  const scoresA = byCase(resultsA);
  const scoresB = byCase(resultsB);

  const splits: Comparison["splits"] = [];
  for (const split of options.split ? [options.split] : SPLITS) {
    const listA: number[] = [];
    const listB: number[] = [];
    const differences: CaseDifference[] = [];
    let unpaired = 0;
    for (const c of cases.filter((item) => item.split === split)) {
      const sa = scoresA.get(c.id);
      const sb = scoresB.get(c.id);
      if (!sa || !sb) {
        if (sa || sb) unpaired++;
        continue;
      }
      listA.push(sa.score);
      listB.push(sb.score);
      if (sa.score !== sb.score) differences.push({ caseId: c.id, a: sa.score, b: sb.score });
    }
    if (listA.length === 0 && unpaired === 0) continue;
    splits.push({ split, result: pairedComparison(listA, listB, options), differences, unpaired });
  }
  return { scorer, a, b, splits };
}

export interface ReliabilityCase {
  caseId: string;
  scores: number[];
  stddev: number;
}

export interface ReliabilityReport {
  method: string;
  scorer: string;
  repeats: number;
  cases: number;
  /** Scoring calls that threw. Cases with fewer than two successful repeats are left out. */
  failures: number;
  /** Mean share of repeats that agree with the most common score for the case. */
  scoreAgreement: number;
  /** Share of cases where every repeat gave the same score. */
  unanimous: number;
  /** Mean share of repeats that agree with the most common pass or fail verdict for the case. */
  passAgreement: number;
  /** Cases that received both a pass and a fail. */
  passFlips: number;
  /** Mean per-case standard deviation of the normalized score. */
  meanStddev: number;
  leastStable: ReliabilityCase[];
}

/**
 * Scores each cached output `repeats` times with the same scorer and measures
 * how often the scorer agrees with itself. Nothing is written to disk.
 */
export async function measureReliability(
  project: Project,
  cases: Case[],
  method: string,
  scorer: Scorer,
  options: { repeats?: number; split?: Split; limit?: number; concurrency?: number } = {},
): Promise<ReliabilityReport> {
  const repeats = options.repeats ?? 5;
  if (!Number.isInteger(repeats) || repeats < 2) throw new Error("repeats must be an integer of at least 2");
  const loaded = await loadMethodResults(project, method, selectCases(cases, options.split));
  let items = loaded.fresh.filter((item) => item.record.status === "ok");
  if (options.limit !== undefined) items = items.slice(0, options.limit);

  let failures = 0;
  const perCase = await mapLimit(items, options.concurrency ?? 4, async ({ c, record }) => {
    const scores: number[] = [];
    const passes: boolean[] = [];
    for (let i = 0; i < repeats; i++) {
      try {
        const result = await scorer.score({ caseId: c.id, input: c.input, reference: c.reference, output: record.output });
        scores.push(result.score);
        passes.push(result.pass);
      } catch {
        failures++;
      }
    }
    return { caseId: c.id, scores, passes };
  });

  const usable = perCase.filter((item) => item.scores.length >= 2);
  const modalShare = (values: (number | boolean)[]): number => {
    const counts = new Map<number | boolean, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return Math.max(...counts.values()) / values.length;
  };
  const stability: ReliabilityCase[] = usable.map((item) => ({
    caseId: item.caseId, scores: item.scores, stddev: stddev(item.scores),
  }));
  return {
    method,
    scorer: scorer.name,
    repeats,
    cases: usable.length,
    failures,
    scoreAgreement: mean(usable.map((item) => modalShare(item.scores))),
    unanimous: mean(usable.map((item) => (new Set(item.scores).size === 1 ? 1 : 0))),
    passAgreement: mean(usable.map((item) => modalShare(item.passes))),
    passFlips: usable.filter((item) => new Set(item.passes).size > 1).length,
    meanStddev: mean(stability.map((item) => item.stddev)),
    leastStable: stability.filter((item) => item.stddev > 0).sort((x, y) => y.stddev - x.stddev).slice(0, 5),
  };
}

// Text rendering

export function formatTable(headers: string[], rows: string[][], rightAligned: number[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (rightAligned.includes(i) ? cell.padStart(widths[i] as number) : cell.padEnd(widths[i] as number)))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const num = (value: number, digits = 3) => (Number.isNaN(value) ? "-" : value.toFixed(digits));
const pct = (value: number) => (Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`);
const signed = (value: number) => (Number.isNaN(value) ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`);

function formatLatency(ms: number): string {
  if (Number.isNaN(ms)) return "-";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
}

export function formatLeaderboard(board: Leaderboard): string {
  const headers = ["split", "method", "n", "mean", "95% CI", "pass", "latency", "cost", "completed", "errors"];
  const rows = board.rows.map((r) => [
    r.split,
    r.method,
    String(r.n),
    num(r.mean),
    r.n ? `[${num(r.lo)}, ${num(r.hi)}]` : "-",
    pct(r.passRate),
    formatLatency(r.meanLatencyMs),
    r.totalCostUsd === null ? "-" : `$${r.totalCostUsd.toFixed(4)}`,
    `${r.ok}/${r.total}`,
    String(r.errors),
  ]);
  const notes: string[] = [];
  for (const r of board.rows) {
    if (r.unscored) notes.push(`${r.method} (${r.split}): ${r.unscored} results have no "${board.scorer}" score and are left out. Run: evalbench score ${r.method} --scorer ${board.scorer}`);
  }
  for (const s of board.stale) {
    notes.push(`${s.method}: ${s.count} stale results ignored (the method file or the case changed). Run: evalbench run ${s.method}`);
  }
  return [`Scorer: ${board.scorer}`, "", formatTable(headers, rows, [2, 3, 5, 6, 7, 8, 9]), ...(notes.length ? ["", ...notes] : [])].join("\n");
}

export function formatComparison(comparison: Comparison): string {
  const { a, b } = comparison;
  const out: string[] = [`Scorer: ${comparison.scorer}`, `Paired comparison: ${a} against ${b}`];
  if (comparison.splits.length === 0) out.push("", "No cases with scored results for both methods.");
  for (const { split, result, differences, unpaired } of comparison.splits) {
    out.push("", `Split: ${split} (${result.n} paired cases)`);
    if (result.n > 0) {
      out.push(
        `  ${a} wins: ${result.wins}   ${b} wins: ${result.losses}   ties: ${result.ties}`,
        `  mean ${a}: ${num(result.meanA)}   mean ${b}: ${num(result.meanB)}`,
        `  difference (${a} minus ${b}): ${signed(result.diff.mean)}, 95% CI [${signed(result.diff.lo)}, ${signed(result.diff.hi)}]`,
        result.diff.lo > 0
          ? `  The interval is above zero: ${a} scores higher on this split.`
          : result.diff.hi < 0
            ? `  The interval is below zero: ${b} scores higher on this split.`
            : "  The interval includes zero: this case set does not separate the two methods.",
      );
    }
    if (unpaired) out.push(`  ${unpaired} cases have a scored result for only one of the methods and are left out.`);
    if (differences.length) {
      out.push("", formatTable(["case", a, b], differences.map((d) => [d.caseId, num(d.a), num(d.b)]), [1, 2]).replace(/^/gm, "  "));
    }
  }
  return out.join("\n");
}

export function formatReliability(reports: ReliabilityReport[]): string {
  const first = reports[0];
  if (!first) return "No results to score.";
  const headers = ["method", "cases", "score agreement", "unanimous", "pass agreement", "pass flips", "mean sd", "failed calls"];
  const rows = reports.map((r) => [
    r.method, String(r.cases), pct(r.scoreAgreement), pct(r.unanimous), pct(r.passAgreement),
    String(r.passFlips), num(r.meanStddev), String(r.failures),
  ]);
  const out = [`Scorer: ${first.scorer}, ${first.repeats} repeats per output`, "", formatTable(headers, rows, [1, 2, 3, 4, 5, 6, 7])];
  for (const r of reports) {
    if (r.leastStable.length === 0) continue;
    out.push("", `Least stable cases for ${r.method}:`);
    for (const item of r.leastStable) {
      out.push(`  ${item.caseId}: scores ${item.scores.map((s) => s.toFixed(2)).join(", ")}`);
    }
  }
  return out.join("\n");
}
