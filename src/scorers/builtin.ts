import { canonicalJson, sha256 } from "../hash.ts";
import type { Scorer, ScorerOptions, ScoreInput, ScoreOutput } from "./types.ts";

function binary(pass: boolean, reason: string): ScoreOutput {
  return { score: pass ? 1 : 0, pass, reason };
}

function requireReference(input: ScoreInput, scorer: string): unknown {
  if (input.reference === undefined || input.reference === null) {
    throw new Error(`the ${scorer} scorer needs a reference, and case "${input.caseId}" has none`);
  }
  return input.reference;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Strings are compared after trimming surrounding whitespace. Other values are
 * compared structurally, ignoring object key order.
 */
export function exactScorer(options: ScorerOptions = {}): Scorer {
  const ignoreCase = options.ignoreCase ?? false;
  const normalize = (value: unknown): string => {
    if (typeof value !== "string") return canonicalJson(value);
    const trimmed = value.trim();
    return ignoreCase ? trimmed.toLowerCase() : trimmed;
  };
  return {
    name: "exact",
    configHash: sha256(canonicalJson({ scorer: "exact", ignoreCase })),
    async score(input) {
      const reference = requireReference(input, "exact");
      const pass =
        typeof reference === typeof input.output && normalize(reference) === normalize(input.output);
      return binary(pass, pass ? "matches the reference" : "differs from the reference");
    },
  };
}

/** Reads the first number in a value. Thousands separators such as 1,250 are accepted. */
export function extractNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const match = text.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Passes when the first number in the output is within the tolerance of the reference number. */
export function numericScorer(options: ScorerOptions = {}): Scorer {
  const tolerance = options.tolerance ?? 0;
  if (!(tolerance >= 0)) throw new Error(`tolerance must be zero or greater, got ${tolerance}`);
  return {
    name: "numeric",
    configHash: sha256(canonicalJson({ scorer: "numeric", tolerance })),
    async score(input) {
      const expected = extractNumber(requireReference(input, "numeric"));
      if (expected === null) throw new Error(`the reference of case "${input.caseId}" holds no number`);
      const actual = extractNumber(input.output);
      if (actual === null) return binary(false, "no number found in the output");
      const pass = Math.abs(actual - expected) <= tolerance + Number.EPSILON * Math.abs(expected);
      return binary(pass, `output ${actual}, reference ${expected}, tolerance ${tolerance}`);
    },
  };
}

/** Passes when the output matches a pattern. Without --pattern, the case reference is the pattern. */
export function regexScorer(options: ScorerOptions = {}): Scorer {
  const flags = options.flags ?? "";
  if (options.pattern !== undefined) new RegExp(options.pattern, flags);
  return {
    name: "regex",
    configHash: sha256(canonicalJson({ scorer: "regex", pattern: options.pattern ?? null, flags })),
    async score(input) {
      const source = options.pattern ?? asText(requireReference(input, "regex"));
      const pass = new RegExp(source, flags).test(asText(input.output));
      return binary(pass, pass ? `matches /${source}/${flags}` : `does not match /${source}/${flags}`);
    },
  };
}
