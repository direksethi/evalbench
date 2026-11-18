// Handles numeric formats: ISO, US slashes (month first) and dotted (day first).
const pad = (n: string) => n.padStart(2, "0");

export default function run(input: string) {
  const iso = input.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { output: iso[0] };
  const slash = input.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) return { output: `${slash[3]}-${pad(slash[1]!)}-${pad(slash[2]!)}` };
  const dotted = input.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (dotted) return { output: `${dotted[3]}-${pad(dotted[2]!)}-${pad(dotted[1]!)}` };
  return { output: "" };
}
