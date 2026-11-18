import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Case } from "./cases.ts";
import type { Usage } from "./methods.ts";
import type { Split } from "./split.ts";

export interface ScoreSample {
  score: number;
  pass: boolean;
  reason?: string;
}

export interface ScoreEntry {
  scorer: string;
  /** Hash of the scorer configuration. A changed configuration is scored again. */
  configHash: string;
  /** 0 to 1, or null when scoring failed. */
  score: number | null;
  pass: boolean | null;
  reason?: string;
  error?: string;
  /** Individual judge runs when a scorer is sampled more than once. */
  samples?: ScoreSample[];
  scoredAt: string;
}

export interface ResultRecord {
  version: 1;
  method: string;
  caseId: string;
  split: Split;
  methodHash: string;
  caseHash: string;
  status: "ok" | "error";
  output?: unknown;
  usage?: Usage;
  error?: { message: string; stack?: string };
  /** Wall time of the method call as measured by the harness. */
  latencyMs: number;
  startedAt: string;
  scores: Record<string, ScoreEntry>;
}

export function resultPath(resultsDir: string, method: string, caseId: string): string {
  return join(resultsDir, method, `${caseId}.json`);
}

export async function readResult(
  resultsDir: string,
  method: string,
  caseId: string,
): Promise<ResultRecord | null> {
  try {
    const data = JSON.parse(await readFile(resultPath(resultsDir, method, caseId), "utf8"));
    if (data?.version !== 1 || typeof data.methodHash !== "string" || typeof data.caseHash !== "string") {
      return null;
    }
    data.scores ??= {};
    return data as ResultRecord;
  } catch {
    return null;
  }
}

export async function writeResult(resultsDir: string, record: ResultRecord): Promise<void> {
  const file = resultPath(resultsDir, record.method, record.caseId);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n");
  await rename(temp, file);
}

/** Methods that have a directory under results/. */
export async function listResultMethods(resultsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(resultsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * A result is fresh when it was produced from the current case content and the
 * current method file. When the method file is gone (methodHash null) only the
 * case is checked.
 */
export function isFresh(record: ResultRecord, c: Case, methodHash: string | null): boolean {
  return record.caseHash === c.hash && (methodHash === null || record.methodHash === methodHash);
}

/** Wall time reported by the method when present, otherwise the measured one. */
export function latencyOf(record: ResultRecord): number {
  return record.usage?.latencyMs ?? record.latencyMs;
}
