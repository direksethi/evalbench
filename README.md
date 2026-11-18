# evalbench

A file-based benchmark harness for comparing LLM pipelines on a fixed set of cases.

Prompt and pipeline changes are usually judged by trying a few inputs and deciding it feels better. evalbench replaces that with a number you can defend: every variant runs over the same cases, results are cached, scores come with a confidence interval, and a held-out split stays untouched until you ask for it.

The idea in three lines:

- A **case** is a JSON file. A **method** is a file that exports one function. Adding either is adding a file.
- Running a method writes one result file per case, and a case is only rerun when the method file or the case changes.
- Scoring is separate from running, so you can change how you grade without paying for the model calls again.

## Quick start

Requires Node.js 22 or later. The example needs no API key.

```sh
git clone https://github.com/direksethi/evalbench.git
cd evalbench
npm install
npm run example
```

The example task is extracting a date from a sentence, with three methods of increasing quality. It prints:

```
Scorer: exact

split  method    n   mean  95% CI            pass  latency  cost  completed  errors
-----  -------  --  -----  --------------  ------  -------  ----  ---------  ------
dev    rules    15  1.000  [1.000, 1.000]  100.0%  0.09 ms     -      15/15       0
dev    numeric  15  0.467  [0.200, 0.733]   46.7%  0.04 ms     -      15/15       0
dev    naive    15  0.333  [0.133, 0.600]   33.3%  0.03 ms     -      15/15       0
```

Then compare two of them case by case:

```sh
node bin/evalbench.js compare numeric rules --dir examples/dates
```

```
Split: dev (15 paired cases)
  numeric wins: 0   rules wins: 8   ties: 7
  difference (numeric minus rules): -0.533, 95% CI [-0.800, -0.267]
  The interval is below zero: rules scores higher on this split.
```

## Project layout

```
my-benchmark/
  cases/      one JSON file per case
  methods/    one file per method
  scorers/    optional custom scorers
  results/    written by evalbench, safe to delete
```

Pass the directory with `--dir`, or run from inside it.

## Writing cases

```json
{ "id": "iso-plain", "input": "The invoice is due on 2026-03-14.", "reference": "2026-03-14" }
```

`id` and `input` are required. `input` and `reference` can be any JSON value. `split` is optional: when it is absent, the split is derived from a hash of the id, with one case in five going to holdout. The same id always lands in the same split, and adding or removing other cases never moves it.

## Writing a method

A method is a `.ts`, `.mts`, `.js` or `.mjs` file in `methods/` whose default export takes the case input and returns an output:

```ts
export default function run(input: string) {
  return { output: input.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "" };
}
```

There is no registration: the file name is the method name. To call a model, use the context, which talks to any OpenAI-compatible endpoint:

```ts
import type { MethodContext } from "evalbench";

export default async function run(input: string, ctx: MethodContext) {
  const reply = await ctx.chat({
    temperature: 0,
    messages: [{ role: "user", content: `Reply with the date as YYYY-MM-DD: ${input}` }],
    signal: ctx.signal,
  });
  return { output: reply.content.trim(), usage: reply.usage };
}
```

Set `EVALBENCH_BASE_URL`, `EVALBENCH_API_KEY` and `EVALBENCH_MODEL`. Returning `usage` (tokens, `costUsd`, `latencyMs`) fills the cost and latency columns. A method is free to ignore `ctx.chat` and use any client it likes.

## Running and caching

```sh
evalbench run rules                       # the dev split
evalbench run rules --split holdout       # only when asked for by name
evalbench run rules --concurrency 8 --limit 20 --timeout 60000
```

A case is skipped when a successful result exists for the same method file content and the same case content. Editing the method file reruns everything for that method; editing one case reruns that case. A failure is recorded with its error and does not stop the run; failed cases are tried again next time and count as zero on the leaderboard, so a method cannot look better by crashing on the hard cases. `--force` ignores the cache.

## Scoring

```sh
evalbench score rules --scorer exact
evalbench run rules --scorer exact        # run, then score
```

| Scorer | Passes when |
| --- | --- |
| `exact` | The output equals the reference. Strings are trimmed (`--ignore-case` available); other values are compared structurally. |
| `numeric` | The first number in the output is within `--tolerance` of the reference. |
| `regex` | The output matches `--pattern`, or the reference used as a pattern. |
| `judge` | A model grades the output against the reference on a rubric. |
| a file in `scorers/` | Your function returns a score from 0 to 1. |

A custom scorer default-exports `({ caseId, input, reference, output }) => ({ score, pass?, reason? })`.

### The judge

The judge sends the input, reference and candidate to a model with a rubric, and reads back a score from 1 to 5 with a reason. It needs `EVALBENCH_BASE_URL` and `EVALBENCH_JUDGE_MODEL`.

```sh
evalbench score rules --scorer judge --judge-runs 3 --aggregate majority
```

A judge is itself a noisy instrument, so measure it before trusting it:

```sh
evalbench reliability rules --scorer judge --repeats 5
```

This scores each cached output several times and reports how often the judge agrees with itself: the share of repeats matching the most common score, how many cases flipped between pass and fail, and the least stable cases. If the judge cannot agree with itself, differences between methods smaller than that noise mean nothing.

## Reading the leaderboard

`mean` is the average score and `95% CI` is a percentile bootstrap interval for it. Two methods whose intervals overlap heavily have not been told apart by this case set. `compare` is the sharper tool: it resamples cases as pairs, which keeps the per-case correlation between the two methods and gives a tighter interval on the difference.

Tune on `dev`. Run `holdout` rarely, when you are about to make a decision. Every time you look at holdout scores and then change a method, the holdout set becomes a little more like the dev set.

Results from an older version of a method file or case are ignored and reported as stale.

## CLI reference

Run `evalbench --help` for every option. Commands: `run`, `score`, `leaderboard`, `compare`, `reliability`, `methods`.

## Development

```sh
npm test            # cache rules, split, failure isolation, statistics, judge against a local stub server
npm run typecheck
```

## Limitations

- Results live on local disk. There is no shared store and no dashboard.
- Method files are loaded with `tsx`, so they run with full access to the machine. Only run methods you trust.
- The cache key is the content of the method file itself. A change in a file it imports, or in a model behind an API, does not invalidate results: use `--force`.
- The built-in client speaks the OpenAI chat completions format only.
- The package is not published to npm. Use it from a clone.

## License

MIT, see [LICENSE](LICENSE).
