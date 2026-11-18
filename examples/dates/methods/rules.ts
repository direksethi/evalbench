// Numeric formats plus month names, in either order, with ordinals.
import numeric from "./numeric.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const pad = (n: string | number) => String(n).padStart(2, "0");

export default function run(input: string) {
  const found = numeric(input).output;
  if (found) return { output: found };

  const text = input.toLowerCase();
  const year = text.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!year) return { output: "" };

  const monthFirst = text.match(new RegExp(`\\b${NAME}\\s+${DAY}\\b`));
  const dayFirst = text.match(new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${NAME}`));
  const month = monthFirst?.[1] ?? dayFirst?.[2];
  const day = monthFirst?.[2] ?? dayFirst?.[1];
  if (!month || !day) return { output: "" };
  return { output: `${year}-${pad(MONTHS.indexOf(month) + 1)}-${pad(day)}` };
}
