import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./hash.ts";
import { DEFAULT_HOLDOUT_FRACTION, isSplit, splitForId, type Split } from "./split.ts";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface Case {
  id: string;
  input: unknown;
  reference?: unknown;
  split: Split;
  /** "file" when the case file sets the split, "hash" when it was derived from the id. */
  splitSource: "file" | "hash";
  /** Hash of id, input and reference. The split is not part of it. */
  hash: string;
  file: string;
}

export function caseHash(id: string, input: unknown, reference: unknown): string {
  return sha256(canonicalJson({ id, input, reference: reference ?? null }));
}

export async function loadCases(
  casesDir: string,
  holdoutFraction = DEFAULT_HOLDOUT_FRACTION,
): Promise<Case[]> {
  let names: string[];
  try {
    names = await readdir(casesDir);
  } catch {
    throw new Error(`cases directory not found: ${casesDir}`);
  }
  const cases: Case[] = [];
  const seen = new Map<string, string>();
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = join(casesDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${file}: a case must be a JSON object`);
    }
    const data = raw as Record<string, unknown>;
    const id = data.id;
    if (typeof id !== "string" || !NAME_PATTERN.test(id)) {
      throw new Error(`${file}: "id" must be a string of letters, digits, dot, dash or underscore`);
    }
    if (!("input" in data)) throw new Error(`${file}: "input" is required`);
    if (data.split !== undefined && !isSplit(data.split)) {
      throw new Error(`${file}: "split" must be "dev" or "holdout"`);
    }
    const previous = seen.get(id);
    if (previous) throw new Error(`duplicate case id "${id}" in ${previous} and ${file}`);
    seen.set(id, file);
    const explicit = isSplit(data.split) ? data.split : undefined;
    cases.push({
      id,
      input: data.input,
      reference: data.reference,
      split: explicit ?? splitForId(id, holdoutFraction),
      splitSource: explicit ? "file" : "hash",
      hash: caseHash(id, data.input, data.reference),
      file,
    });
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cases;
}

/** Writes the hash-assigned split into case files that do not set one. Returns the number of files changed. */
export async function writeSplits(cases: Case[]): Promise<number> {
  let written = 0;
  for (const c of cases) {
    if (c.splitSource === "file") continue;
    const data = JSON.parse(await readFile(c.file, "utf8")) as Record<string, unknown>;
    data.split = c.split;
    await writeFile(c.file, JSON.stringify(data, null, 2) + "\n");
    written++;
  }
  return written;
}
