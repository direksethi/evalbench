import { sha256 } from "./hash.ts";

export type Split = "dev" | "holdout";

export const SPLITS: readonly Split[] = ["dev", "holdout"];
export const DEFAULT_HOLDOUT_FRACTION = 0.2;

/**
 * Assigns a split from the case id alone. The same id always lands in the same
 * split, and adding or removing other cases never moves it.
 */
export function splitForId(id: string, holdoutFraction = DEFAULT_HOLDOUT_FRACTION): Split {
  if (!(holdoutFraction >= 0 && holdoutFraction <= 1)) {
    throw new Error(`holdout fraction must be between 0 and 1, got ${holdoutFraction}`);
  }
  const bucket = parseInt(sha256(`evalbench-split:${id}`).slice(0, 8), 16) / 0x100000000;
  return bucket < holdoutFraction ? "holdout" : "dev";
}

export function isSplit(value: unknown): value is Split {
  return value === "dev" || value === "holdout";
}
