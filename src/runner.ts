import type { Case } from "./cases.ts";
import type { LoadedMethod, MethodContext, Usage } from "./methods.ts";
import { chatCompletion } from "./openai.ts";
import { mapLimit } from "./pool.ts";
import { readResult, writeResult, type ResultRecord } from "./results.ts";
import type { Split } from "./split.ts";

export interface RunOptions {
  /** Defaults to "dev". The holdout split is only run when asked for by name. */
  split?: Split;
  concurrency?: number;
  /** Only the first n cases of the split, ordered by id. */
  limit?: number;
  /** Rerun cases that have a cached result. */
  force?: boolean;
  /** Per-case timeout in milliseconds. No timeout when unset. */
  timeoutMs?: number;
  onResult?: (record: ResultRecord, cached: boolean) => void;
}

export interface RunSummary {
  method: string;
  split: Split;
  total: number;
  ran: number;
  cached: number;
  ok: number;
  errors: number;
  records: ResultRecord[];
}

export function selectCases(cases: Case[], split: Split | undefined, limit?: number): Case[] {
  const selected = split ? cases.filter((c) => c.split === split) : cases;
  return limit === undefined ? selected : selected.slice(0, limit);
}

export async function runMethod(
  method: LoadedMethod,
  cases: Case[],
  resultsDir: string,
  options: RunOptions = {},
): Promise<RunSummary> {
  const split = options.split ?? "dev";
  const selected = selectCases(cases, split, options.limit);
  const summary: RunSummary = {
    method: method.name, split, total: selected.length, ran: 0, cached: 0, ok: 0, errors: 0, records: [],
  };

  summary.records = await mapLimit(selected, options.concurrency ?? 4, async (c) => {
    if (!options.force) {
      const previous = await readResult(resultsDir, method.name, c.id);
      // Only successful results are reused. A recorded failure is tried again.
      if (previous?.status === "ok" && previous.methodHash === method.hash && previous.caseHash === c.hash) {
        summary.cached++;
        summary.ok++;
        options.onResult?.(previous, true);
        return previous;
      }
    }
    const record = await runCase(method, c, options.timeoutMs);
    await writeResult(resultsDir, record);
    summary.ran++;
    if (record.status === "ok") summary.ok++;
    else summary.errors++;
    options.onResult?.(record, false);
    return record;
  });
  return summary;
}

/** Runs one case. Never throws: a failure becomes a record with status "error". */
export async function runCase(method: LoadedMethod, c: Case, timeoutMs?: number): Promise<ResultRecord> {
  const controller = new AbortController();
  const ctx: MethodContext = {
    caseId: c.id,
    split: c.split,
    method: method.name,
    signal: controller.signal,
    chat: (request) => chatCompletion({ signal: controller.signal, ...request }),
  };
  const record: ResultRecord = {
    version: 1,
    method: method.name,
    caseId: c.id,
    split: c.split,
    methodHash: method.hash,
    caseHash: c.hash,
    status: "ok",
    latencyMs: 0,
    startedAt: new Date().toISOString(),
    scores: {},
  };
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = Promise.resolve().then(() => method.run(structuredClone(c.input), ctx));
    const value = timeoutMs
      ? await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(new Error("timeout"));
              reject(new Error(`timed out after ${timeoutMs} ms`));
            }, timeoutMs);
          }),
        ])
      : await work;
    if (value === null || typeof value !== "object" || !("output" in value) || value.output === undefined) {
      throw new Error("a method must return an object of the form { output, usage? }");
    }
    // Round trip through JSON so the record holds exactly what will be on disk.
    record.output = JSON.parse(JSON.stringify(value.output));
    const usage = cleanUsage(value.usage);
    if (usage) record.usage = usage;
  } catch (err) {
    record.status = "error";
    const error = err instanceof Error ? err : new Error(String(err));
    record.error = { message: error.message, stack: error.stack };
  } finally {
    clearTimeout(timer);
    record.latencyMs = Math.round((performance.now() - started) * 1000) / 1000;
  }
  return record;
}

function cleanUsage(usage: unknown): Usage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const source = usage as Record<string, unknown>;
  const clean: Usage = {};
  for (const key of ["inputTokens", "outputTokens", "costUsd", "latencyMs"] as const) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
}
