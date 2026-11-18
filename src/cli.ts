import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCases } from "./cases.ts";
import { listMethods, loadMethod, methodFileHash } from "./methods.ts";
import {
  buildComparison, buildLeaderboard, formatComparison, formatLeaderboard, formatReliability,
  measureReliability, type Project,
} from "./report.ts";
import { runMethod } from "./runner.ts";
import { scoreMethod } from "./score.ts";
import { createScorer } from "./scorers/index.ts";
import type { ScorerOptions } from "./scorers/types.ts";
import { isSplit, type Split } from "./split.ts";

const HELP = `evalbench: compare LLM pipelines on a fixed case set.

Usage:
  evalbench run <method>          Run a method over the cases and cache one result per case.
  evalbench score <method>        Score cached results without running the method.
  evalbench leaderboard           Table of every method: mean score with a 95% interval, pass rate, latency, cost.
  evalbench compare <a> <b>       Paired comparison of two methods on the cases both have results for.
  evalbench reliability <method>  Score cached outputs several times and report how often the scorer agrees with itself.
  evalbench methods               List the method files.

Options:
  --dir <path>          Project directory holding cases/, methods/, scorers/, results/ (default: current directory)
  --split <dev|holdout> run: default dev. score, leaderboard, compare: default both.
  --scorer <name>       exact, numeric, regex, judge, or a file in scorers/. With run, scores right after running.
  --concurrency <n>     Parallel cases (default 4)
  --limit <n>           Only the first n cases of the split
  --force               Ignore cached results (run) or cached scores (score)
  --timeout <ms>        Per-case timeout for run
  --ignore-case         exact scorer: compare without regard to case
  --tolerance <x>       numeric scorer: allowed absolute difference
  --pattern <regex>     regex scorer: pattern (default: the case reference)
  --rubric <text>       judge scorer: rubric
  --judge-runs <n>      judge scorer: calls per output (default 1)
  --aggregate <mode>    judge scorer: median or majority (default median)
  --pass-threshold <x>  judge and custom scorers: lowest passing score, 0 to 1
  --repeats <n>         reliability: scoring passes per output (default 5)
  --seed <n>            Seed for the bootstrap, for repeatable intervals
  -h, --help

The judge and ctx.chat use an OpenAI-compatible endpoint:
  EVALBENCH_BASE_URL, EVALBENCH_API_KEY, EVALBENCH_MODEL, EVALBENCH_JUDGE_MODEL
`;

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        split: { type: "string" },
        scorer: { type: "string" },
        concurrency: { type: "string" },
        limit: { type: "string" },
        force: { type: "boolean" },
        timeout: { type: "string" },
        "ignore-case": { type: "boolean" },
        tolerance: { type: "string" },
        pattern: { type: "string" },
        rubric: { type: "string" },
        "judge-runs": { type: "string" },
        aggregate: { type: "string" },
        "pass-threshold": { type: "string" },
        repeats: { type: "string" },
        seed: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    console.error(`evalbench: ${(err as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    out(HELP);
    return command || values.help ? 0 : 2;
  }

  try {
    const root = resolve(values.dir ?? ".");
    const project: Project = {
      casesDir: join(root, "cases"),
      methodsDir: join(root, "methods"),
      scorersDir: join(root, "scorers"),
      resultsDir: join(root, "results"),
    };
    if (values.split !== undefined && !isSplit(values.split)) throw new Error('--split must be "dev" or "holdout"');
    const split = values.split as Split | undefined;
    const concurrency = int(values.concurrency, "concurrency");
    const limit = int(values.limit, "limit");
    const seed = int(values.seed, "seed");
    if (values.aggregate !== undefined && values.aggregate !== "median" && values.aggregate !== "majority") {
      throw new Error('--aggregate must be "median" or "majority"');
    }
    const scorerOptions: ScorerOptions = {
      ignoreCase: values["ignore-case"],
      tolerance: num(values.tolerance, "tolerance"),
      pattern: values.pattern,
      rubric: values.rubric,
      judgeRuns: int(values["judge-runs"], "judge-runs"),
      aggregate: values.aggregate as "median" | "majority" | undefined,
      passThreshold: num(values["pass-threshold"], "pass-threshold"),
    };
    const scorerFor = (name: string) => createScorer(name, scorerOptions, { scorersDir: project.scorersDir });
    const need = (index: number, what: string): string => {
      const value = rest[index];
      if (!value) throw new Error(`${command}: missing ${what}`);
      return value;
    };

    const score = async (method: string, scorerName: string) => {
      const scorer = await scorerFor(scorerName);
      const cases = await loadCases(project.casesDir);
      const summary = await scoreMethod(method, cases, project.resultsDir, scorer, {
        split, limit, concurrency, force: values.force,
        methodHash: await methodFileHash(project.methodsDir, method),
      });
      out(
        `scored ${method} with ${summary.scorer}: ${summary.scored} scored, ${summary.cached} cached, ` +
          `${summary.failed} failed, ${summary.errorResults} error results, ${summary.missing} missing, ${summary.stale} stale`,
      );
      return summary.failed === 0;
    };

    switch (command) {
      case "methods": {
        for (const name of await listMethods(project.methodsDir)) out(name);
        return 0;
      }
      case "run": {
        const name = need(0, "method name");
        const method = await loadMethod(project.methodsDir, name);
        const cases = await loadCases(project.casesDir);
        const summary = await runMethod(method, cases, project.resultsDir, {
          split, concurrency, limit, force: values.force, timeoutMs: int(values.timeout, "timeout"),
        });
        out(
          `ran ${summary.method} on ${summary.split}: ${summary.total} cases, ${summary.ran} run, ` +
            `${summary.cached} cached, ${summary.ok} ok, ${summary.errors} errors`,
        );
        if (values.scorer) await score(name, values.scorer);
        return summary.errors === 0 ? 0 : 1;
      }
      case "score": {
        if (!values.scorer) throw new Error("score: --scorer is required");
        return (await score(need(0, "method name"), values.scorer)) ? 0 : 1;
      }
      case "leaderboard": {
        const cases = await loadCases(project.casesDir);
        out(formatLeaderboard(await buildLeaderboard(project, cases, { scorer: values.scorer, split, seed })));
        return 0;
      }
      case "compare": {
        const cases = await loadCases(project.casesDir);
        const comparison = await buildComparison(project, cases, need(0, "first method"), need(1, "second method"), {
          scorer: values.scorer, split, seed,
        });
        out(formatComparison(comparison));
        return 0;
      }
      case "reliability": {
        const name = need(0, "method name");
        const scorer = await scorerFor(values.scorer ?? "judge");
        const cases = await loadCases(project.casesDir);
        const report = await measureReliability(project, cases, name, scorer, {
          repeats: int(values.repeats, "repeats"), split, limit, concurrency,
        });
        out(formatReliability([report]));
        return 0;
      }
      default:
        throw new Error(`unknown command "${command}". Run evalbench --help.`);
    }
  } catch (err) {
    console.error(`evalbench: ${(err as Error).message}`);
    return 1;
  }
}
