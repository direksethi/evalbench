import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bootstrapMeanCI, buildLeaderboard, createScorer, judgeScorer, loadCases, loadMethod, pairedComparison,
  parseJudgeResponse, runMethod, scoreMethod, splitForId, type Project,
} from "../src/index.ts";
import { mapLimit } from "../src/pool.ts";

async function project(methods: Record<string, string>, cases: object[]): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "evalbench-"));
  const p: Project = {
    casesDir: join(root, "cases"), methodsDir: join(root, "methods"),
    scorersDir: join(root, "scorers"), resultsDir: join(root, "results"),
  };
  await mkdir(p.casesDir);
  await mkdir(p.methodsDir);
  for (const c of cases) await writeFile(join(p.casesDir, `${(c as { id: string }).id}.json`), JSON.stringify(c));
  for (const [name, source] of Object.entries(methods)) await writeFile(join(p.methodsDir, `${name}.mjs`), source);
  return p;
}

const CASES = [
  { id: "a", input: 1, reference: 2, split: "dev" },
  { id: "b", input: 2, reference: 4, split: "dev" },
  { id: "c", input: 3, reference: 6, split: "dev" },
  { id: "h", input: 4, reference: 8, split: "holdout" },
];
const DOUBLE = "export default (x) => ({ output: x * 2 });\n";

test("the split is derived from the id alone and is stable", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `case-${i}`);
  const first = ids.map((id) => splitForId(id));
  assert.deepEqual(ids.map((id) => splitForId(id)), first);
  const share = first.filter((s) => s === "holdout").length / ids.length;
  assert.ok(share > 0.15 && share < 0.25, `holdout share ${share}`);
  assert.equal(splitForId("x", 0), "dev");
  assert.equal(splitForId("x", 1), "holdout");
});

test("run skips cached cases and holdout, and reruns when the method or a case changes", async () => {
  const p = await project({ m: DOUBLE }, CASES);
  let cases = await loadCases(p.casesDir);
  const first = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir);
  assert.deepEqual([first.total, first.ran, first.cached], [3, 3, 0]);

  const second = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir);
  assert.deepEqual([second.ran, second.cached], [0, 3]);

  await writeFile(join(p.casesDir, "a.json"), JSON.stringify({ ...CASES[0], input: 10, reference: 20 }));
  cases = await loadCases(p.casesDir);
  const afterCase = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir);
  assert.deepEqual([afterCase.ran, afterCase.cached], [1, 2]);

  await writeFile(join(p.methodsDir, "m.mjs"), `${DOUBLE}// changed\n`);
  const afterMethod = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir);
  assert.deepEqual([afterMethod.ran, afterMethod.cached], [3, 0]);

  const forced = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir, { force: true });
  assert.equal(forced.ran, 3);
  const holdout = await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir, { split: "holdout" });
  assert.equal(holdout.total, 1);
});

test("a failing case is recorded and does not stop the run, and counts as zero", async () => {
  const p = await project(
    { flaky: "export default (x) => { if (x === 2) throw new Error('boom'); return { output: x * 2 }; };\n" },
    CASES,
  );
  const cases = await loadCases(p.casesDir);
  const summary = await runMethod(await loadMethod(p.methodsDir, "flaky"), cases, p.resultsDir);
  assert.deepEqual([summary.ok, summary.errors], [2, 1]);
  assert.equal(summary.records.find((r) => r.caseId === "b")?.error?.message, "boom");

  await scoreMethod("flaky", cases, p.resultsDir, await createScorer("exact"));
  const row = (await buildLeaderboard(p, cases, { split: "dev" })).rows[0]!;
  assert.equal(row.n, 3);
  assert.ok(Math.abs(row.mean - 2 / 3) < 1e-9);
  assert.equal(row.errors, 1);
});

test("scores are cached per scorer configuration", async () => {
  const p = await project({ m: DOUBLE }, CASES);
  const cases = await loadCases(p.casesDir);
  await runMethod(await loadMethod(p.methodsDir, "m"), cases, p.resultsDir);
  const exact = await createScorer("exact");
  assert.equal((await scoreMethod("m", cases, p.resultsDir, exact, { split: "dev" })).scored, 3);
  const again = await scoreMethod("m", cases, p.resultsDir, exact, { split: "dev" });
  assert.deepEqual([again.scored, again.cached], [0, 3]);
});

test("mapLimit never exceeds the concurrency limit and keeps order", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80]);
});

test("bootstrap interval and paired comparison behave on known data", () => {
  const constant = bootstrapMeanCI([0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual([constant.mean, constant.lo, constant.hi], [0.5, 0.5, 0.5]);

  const values = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const ci = bootstrapMeanCI(values, { seed: 7 });
  assert.equal(ci.mean, 0.5);
  assert.ok(ci.lo > 0.4 && ci.lo < 0.5 && ci.hi > 0.5 && ci.hi < 0.6, `${ci.lo} ${ci.hi}`);
  assert.deepEqual(bootstrapMeanCI(values, { seed: 7 }), ci);

  const paired = pairedComparison([1, 1, 1, 0, 1, 1], [0, 0, 1, 0, 0, 0]);
  assert.deepEqual([paired.wins, paired.losses, paired.ties], [4, 0, 2]);
  assert.ok(paired.diff.lo > 0);
  assert.throws(() => pairedComparison([1], [1, 2]));
});

test("the judge reply parser accepts bare, fenced and embedded JSON and rejects bad scores", () => {
  assert.equal(parseJudgeResponse('{"score": 4, "reason": "close"}').score, 4);
  assert.equal(parseJudgeResponse('```json\n{"score": "5", "reason": "exact"}\n```').score, 5);
  assert.equal(parseJudgeResponse('Verdict: {"score": 2, "reason": "has a } brace"} done').reason, "has a } brace");
  assert.throws(() => parseJudgeResponse('{"score": 9}'));
  assert.throws(() => parseJudgeResponse("no json here"));
});

test("the judge scorer calls an OpenAI-compatible endpoint and combines repeated runs", async () => {
  const replies = [5, 3, 5];
  const seen: { auth?: string; model?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, model: JSON.parse(body).model });
      const score = replies[(seen.length - 1) % replies.length];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ score, reason: `gave ${score}` }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const scorer = judgeScorer(
      { judgeRuns: 3, aggregate: "majority" },
      { EVALBENCH_BASE_URL: `http://127.0.0.1:${port}/v1`, EVALBENCH_JUDGE_MODEL: "judge-model", EVALBENCH_API_KEY: "k" },
    );
    const result = await scorer.score({ caseId: "a", input: "q", reference: "r", output: "o" });
    assert.equal(result.score, 1);
    assert.equal(result.pass, true);
    assert.equal(result.samples?.length, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[0], { auth: "Bearer k", model: "judge-model" });
  } finally {
    server.close();
  }
  assert.throws(() => judgeScorer({}, {}));
});
