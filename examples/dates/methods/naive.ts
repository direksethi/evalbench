// Baseline: return the first thing that looks like an ISO date, or nothing.
export default function run(input: string) {
  return { output: input.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "" };
}
