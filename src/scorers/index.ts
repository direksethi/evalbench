import { readFile } from "node:fs/promises";
import { canonicalJson, sha256 } from "../hash.ts";
import { importDefault, resolveModuleFile } from "../methods.ts";
import { exactScorer, numericScorer, regexScorer } from "./builtin.ts";
import { judgeScorer } from "./judge.ts";
import type { CustomScorerFn, Scorer, ScorerOptions } from "./types.ts";

export const BUILTIN_SCORERS = ["exact", "numeric", "regex", "judge"] as const;
export const DEFAULT_CUSTOM_PASS_THRESHOLD = 0.5;

export interface ScorerEnvironment {
  /** Directory searched for custom scorer files. */
  scorersDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Builds a scorer by name: a built in one, or a file in the scorers directory. */
export async function createScorer(
  name: string,
  options: ScorerOptions = {},
  environment: ScorerEnvironment = {},
): Promise<Scorer> {
  switch (name) {
    case "exact":
      return exactScorer(options);
    case "numeric":
      return numericScorer(options);
    case "regex":
      return regexScorer(options);
    case "judge":
      return judgeScorer(options, environment.env ?? process.env);
  }
  const file = environment.scorersDir ? await resolveModuleFile(environment.scorersDir, name) : null;
  if (!file) {
    throw new Error(
      `unknown scorer "${name}": use one of ${BUILTIN_SCORERS.join(", ")}, or add scorers/${name}.ts`,
    );
  }
  const contentHash = sha256(await readFile(file));
  const fn = await importDefault(file, contentHash);
  if (typeof fn !== "function") throw new Error(`${file}: the default export must be a function`);
  const passThreshold = options.passThreshold ?? DEFAULT_CUSTOM_PASS_THRESHOLD;
  return {
    name,
    configHash: sha256(canonicalJson({ scorer: name, contentHash, passThreshold })),
    async score(input) {
      const result = await (fn as CustomScorerFn)(input);
      if (typeof result?.score !== "number" || !(result.score >= 0 && result.score <= 1)) {
        throw new Error(`scorer "${name}" must return a score from 0 to 1`);
      }
      return {
        score: result.score,
        pass: typeof result.pass === "boolean" ? result.pass : result.score >= passThreshold,
        reason: result.reason,
      };
    },
  };
}

export * from "./types.ts";
export { exactScorer, numericScorer, regexScorer, extractNumber } from "./builtin.ts";
export {
  judgeScorer, parseJudgeResponse, buildJudgeMessages, majority, normalizeJudgeScore, DEFAULT_RUBRIC,
} from "./judge.ts";
