import { canonicalJson, sha256 } from "../hash.ts";
import { chatCompletion } from "../openai.ts";
import type { ScoreSample } from "../results.ts";
import { median } from "../stats.ts";
import type { Scorer, ScorerOptions, ScoreInput } from "./types.ts";

export const JUDGE_MIN = 1;
export const JUDGE_MAX = 5;
export const DEFAULT_PASS_THRESHOLD = 0.75;

export const DEFAULT_RUBRIC = [
  "5: fully correct and complete; equivalent to the reference where one is given.",
  "4: correct, with minor omissions or wording differences that do not change the meaning.",
  "3: partially correct; a meaningful part is missing or wrong.",
  "2: mostly incorrect, with only fragments that are right.",
  "1: incorrect, empty or unrelated to the input.",
].join("\n");

const SYSTEM_PROMPT =
  "You are a strict, consistent evaluator. Grade the candidate output for the given input using the rubric. " +
  "Judge only what the rubric asks for. " +
  `Reply with a single JSON object and nothing else: {"score": <integer from ${JUDGE_MIN} to ${JUDGE_MAX}>, "reason": "<one or two sentences>"}`;

export interface JudgeVerdict {
  /** Raw rubric score, 1 to 5. */
  score: number;
  reason: string;
}

function show(value: unknown): string {
  if (value === undefined || value === null) return "(none provided)";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function buildJudgeMessages(input: ScoreInput, rubric: string) {
  const user = [
    "## Rubric", rubric,
    "## Input", show(input.input),
    "## Reference output", show(input.reference),
    "## Candidate output", show(input.output),
  ].join("\n\n");
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: user },
  ];
}

/** Every top-level {...} block in a text, found by brace matching outside of strings. */
function jsonObjectCandidates(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/**
 * Reads {"score", "reason"} from a model reply. Accepts a bare JSON object, an
 * object inside a code fence, or an object surrounded by prose. Throws when no
 * score from 1 to 5 can be read.
 */
export function parseJudgeResponse(content: string): JudgeVerdict {
  for (const candidate of [content.trim(), ...jsonObjectCandidates(content)]) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (data === null || typeof data !== "object" || !("score" in data)) continue;
    const record = data as Record<string, unknown>;
    const score = typeof record.score === "string" ? Number(record.score) : record.score;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (score < JUDGE_MIN || score > JUDGE_MAX) {
      throw new Error(`judge score ${score} is outside ${JUDGE_MIN} to ${JUDGE_MAX}`);
    }
    return { score, reason: typeof record.reason === "string" ? record.reason : "" };
  }
  throw new Error(`could not read a score from the judge reply: ${content.slice(0, 200)}`);
}

/** Most frequent score. A tie goes to the lowest of the tied scores. */
export function majority(scores: number[]): number {
  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = NaN;
  let bestCount = 0;
  for (const [score, count] of counts) {
    if (count > bestCount || (count === bestCount && score < best)) {
      best = score;
      bestCount = count;
    }
  }
  return best;
}

export function normalizeJudgeScore(raw: number): number {
  return (raw - JUDGE_MIN) / (JUDGE_MAX - JUDGE_MIN);
}

export function judgeScorer(options: ScorerOptions = {}, env: NodeJS.ProcessEnv = process.env): Scorer {
  const baseUrl = env.EVALBENCH_BASE_URL;
  const model = env.EVALBENCH_JUDGE_MODEL;
  if (!baseUrl || !model) {
    throw new Error("the judge scorer needs EVALBENCH_BASE_URL and EVALBENCH_JUDGE_MODEL (EVALBENCH_API_KEY is optional)");
  }
  const rubric = options.rubric ?? DEFAULT_RUBRIC;
  const runs = options.judgeRuns ?? 1;
  const aggregate = options.aggregate ?? "median";
  const passThreshold = options.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`judge runs must be a positive integer, got ${runs}`);
  const temperature =
    env.EVALBENCH_JUDGE_TEMPERATURE !== undefined && env.EVALBENCH_JUDGE_TEMPERATURE !== ""
      ? Number(env.EVALBENCH_JUDGE_TEMPERATURE)
      : undefined;

  const judgeOnce = async (input: ScoreInput): Promise<JudgeVerdict> => {
    const messages = buildJudgeMessages(input, rubric);
    let lastError: unknown;
    // One extra attempt when the reply cannot be parsed. HTTP retries are handled by chatCompletion.
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await chatCompletion(
        { messages, model, baseUrl, apiKey: env.EVALBENCH_API_KEY, temperature },
        env,
      );
      try {
        return parseJudgeResponse(reply.content);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };

  return {
    name: "judge",
    configHash: sha256(canonicalJson({ scorer: "judge", baseUrl, model, rubric, runs, aggregate, passThreshold, temperature: temperature ?? null })),
    async score(input) {
      const verdicts = await Promise.all(Array.from({ length: runs }, () => judgeOnce(input)));
      const raws = verdicts.map((v) => v.score);
      const raw = aggregate === "majority" ? majority(raws) : median(raws);
      const score = normalizeJudgeScore(raw);
      // Report the reason of the run closest to the combined score.
      const closest = verdicts.reduce((a, b) => (Math.abs(b.score - raw) < Math.abs(a.score - raw) ? b : a));
      const samples: ScoreSample[] = verdicts.map((v) => {
        const normalized = normalizeJudgeScore(v.score);
        return { score: normalized, pass: normalized >= passThreshold, reason: v.reason };
      });
      return {
        score,
        pass: score >= passThreshold,
        reason: runs > 1 ? `${aggregate} of ${raws.join(", ")}: ${closest.reason}` : closest.reason,
        ...(runs > 1 ? { samples } : {}),
      };
    },
  };
}
