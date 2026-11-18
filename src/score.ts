import type { Case } from "./cases.ts";
import { mapLimit } from "./pool.ts";
import { isFresh, readResult, writeResult, type ScoreEntry } from "./results.ts";
import { selectCases } from "./runner.ts";
import type { Scorer } from "./scorers/types.ts";
import type { Split } from "./split.ts";

export interface ScoreOptions {
  /** Both splits when unset. */
  split?: Split;
  limit?: number;
  concurrency?: number;
  /** Score again even when a score with the same scorer configuration exists. */
  force?: boolean;
  /** Current hash of the method file, or null when the file is gone. Used to skip stale results. */
  methodHash?: string | null;
}

export interface ScoreSummary {
  method: string;
  scorer: string;
  scored: number;
  cached: number;
  /** Scorer threw, for example a judge reply that could not be parsed. */
  failed: number;
  /** Results with status "error". They are not scored and count as zero on the leaderboard. */
  errorResults: number;
  /** Cases with no result on disk. */
  missing: number;
  /** Results produced from an older method file or case content. */
  stale: number;
}

/** Scores the results on disk for one method. The method itself is never run. */
export async function scoreMethod(
  method: string,
  cases: Case[],
  resultsDir: string,
  scorer: Scorer,
  options: ScoreOptions = {},
): Promise<ScoreSummary> {
  const summary: ScoreSummary = {
    method, scorer: scorer.name, scored: 0, cached: 0, failed: 0, errorResults: 0, missing: 0, stale: 0,
  };
  const selected = selectCases(cases, options.split, options.limit);
  await mapLimit(selected, options.concurrency ?? 4, async (c) => {
    const record = await readResult(resultsDir, method, c.id);
    if (!record) return void summary.missing++;
    if (!isFresh(record, c, options.methodHash ?? null)) return void summary.stale++;
    if (record.status === "error") return void summary.errorResults++;
    const existing = record.scores[scorer.name];
    if (!options.force && existing && existing.score !== null && existing.configHash === scorer.configHash) {
      return void summary.cached++;
    }
    const entry: ScoreEntry = {
      scorer: scorer.name,
      configHash: scorer.configHash,
      score: null,
      pass: null,
      scoredAt: new Date().toISOString(),
    };
    try {
      const result = await scorer.score({
        caseId: c.id, input: c.input, reference: c.reference, output: record.output,
      });
      entry.score = result.score;
      entry.pass = result.pass;
      if (result.reason) entry.reason = result.reason;
      if (result.samples) entry.samples = result.samples;
      summary.scored++;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      summary.failed++;
    }
    record.scores[scorer.name] = entry;
    await writeResult(resultsDir, record);
  });
  return summary;
}
