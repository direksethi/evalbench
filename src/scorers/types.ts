import type { ScoreSample } from "../results.ts";

export interface ScoreInput {
  caseId: string;
  input: unknown;
  reference: unknown;
  output: unknown;
}

export interface ScoreOutput {
  /** 0 to 1. */
  score: number;
  pass: boolean;
  reason?: string;
  samples?: ScoreSample[];
}

export interface Scorer {
  name: string;
  /** Identifies the configuration, so cached scores are reused only for the same setup. */
  configHash: string;
  score(input: ScoreInput): Promise<ScoreOutput>;
}

export interface ScorerOptions {
  /** exact: compare strings without regard to case. */
  ignoreCase?: boolean;
  /** numeric: allowed absolute difference. Default 0. */
  tolerance?: number;
  /** regex: pattern to test the output against. Defaults to the case reference. */
  pattern?: string;
  /** regex: flags for the pattern. */
  flags?: string;
  /** judge: rubric text. */
  rubric?: string;
  /** judge: number of judge calls per output. Default 1. */
  judgeRuns?: number;
  /** judge: how repeated runs are combined. Default "median". */
  aggregate?: "median" | "majority";
  /** judge and custom scorers: lowest normalized score that passes. */
  passThreshold?: number;
}

/** A custom scorer file default-exports a function of this shape. */
export type CustomScorerFn = (
  input: ScoreInput,
) => Promise<{ score: number; pass?: boolean; reason?: string }> | { score: number; pass?: boolean; reason?: string };
