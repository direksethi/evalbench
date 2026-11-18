import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NAME_PATTERN } from "./cases.ts";
import { sha256 } from "./hash.ts";
import type { ChatRequest, ChatResult } from "./openai.ts";
import type { Split } from "./split.ts";

export const MODULE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** When set, replaces the wall time measured by the harness. */
  latencyMs?: number;
}

export interface MethodOutput {
  output: unknown;
  usage?: Usage;
}

export interface MethodContext {
  caseId: string;
  split: Split;
  method: string;
  /** Aborted when the per-case timeout fires. */
  signal: AbortSignal;
  /** OpenAI-compatible chat completion using EVALBENCH_BASE_URL, EVALBENCH_API_KEY and EVALBENCH_MODEL. */
  chat(request: ChatRequest): Promise<ChatResult>;
}

export type MethodFn = (input: any, ctx: MethodContext) => Promise<MethodOutput> | MethodOutput;

export interface LoadedMethod {
  name: string;
  /** Hash of the method file content. */
  hash: string;
  run: MethodFn;
  file?: string;
}

/** Finds a module by name in a directory, with or without its extension. */
export async function resolveModuleFile(dir: string, name: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  if (entries.includes(name) && (MODULE_EXTENSIONS as readonly string[]).includes(extname(name))) {
    return join(dir, name);
  }
  for (const ext of MODULE_EXTENSIONS) {
    if (entries.includes(name + ext)) return join(dir, name + ext);
  }
  return null;
}

export function moduleName(file: string): string {
  return basename(file, extname(file));
}

export async function listMethods(methodsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(methodsDir);
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => (MODULE_EXTENSIONS as readonly string[]).includes(extname(e)) && !e.endsWith(".d.ts"))
    .map(moduleName);
  return [...new Set(names)].sort();
}

/** Hash of the method file, or null when the file no longer exists. */
export async function methodFileHash(methodsDir: string, name: string): Promise<string | null> {
  const file = await resolveModuleFile(methodsDir, name);
  return file ? sha256(await readFile(file)) : null;
}

/** Imports a module fresh for its current content, so an edited file is not served from the module cache. */
export async function importDefault(file: string, hash: string): Promise<unknown> {
  const mod = await import(`${pathToFileURL(file).href}?v=${hash.slice(0, 16)}`);
  return mod.default;
}

export async function loadMethod(methodsDir: string, name: string): Promise<LoadedMethod> {
  const file = await resolveModuleFile(methodsDir, name);
  if (!file) {
    const available = await listMethods(methodsDir);
    throw new Error(
      `method "${name}" not found in ${methodsDir}` +
        (available.length ? ` (available: ${available.join(", ")})` : ""),
    );
  }
  const methodName = moduleName(file);
  if (!NAME_PATTERN.test(methodName)) {
    throw new Error(`method file name "${methodName}" may only use letters, digits, dot, dash or underscore`);
  }
  const hash = sha256(await readFile(file));
  const run = await importDefault(file, hash);
  if (typeof run !== "function") {
    throw new Error(`${file}: the default export must be an async function run(input, ctx)`);
  }
  return { name: methodName, hash, run: run as MethodFn, file };
}
