import type { Usage } from "./methods.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Defaults to EVALBENCH_MODEL. */
  model?: string;
  /** Defaults to EVALBENCH_BASE_URL, for example https://api.openai.com/v1 */
  baseUrl?: string;
  /** Defaults to EVALBENCH_API_KEY. Omitted from the request when empty. */
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** Extra fields merged into the request body as they are. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Retries after HTTP 429 and 5xx responses and network errors. Default 2. */
  retries?: number;
  retryDelayMs?: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  raw: unknown;
}

/** Calls POST {baseUrl}/chat/completions on any OpenAI-compatible endpoint. */
export async function chatCompletion(
  request: ChatRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatResult> {
  const baseUrl = request.baseUrl ?? env.EVALBENCH_BASE_URL;
  const model = request.model ?? env.EVALBENCH_MODEL;
  const apiKey = request.apiKey ?? env.EVALBENCH_API_KEY;
  if (!baseUrl) throw new Error("EVALBENCH_BASE_URL is not set (for example https://api.openai.com/v1)");
  if (!model) throw new Error("no model given: set EVALBENCH_MODEL or pass a model");

  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = { model, messages: request.messages, ...request.extra };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const retries = request.retries ?? 2;
  const retryDelayMs = request.retryDelayMs ?? 500;
  const started = performance.now();
  let lastError: Error = new Error("request was not attempted");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1), request.signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      lastError = new Error(`request to ${url} failed: ${(err as Error).message}`);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      lastError = new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
      if (response.status === 429 || response.status >= 500) continue;
      throw lastError;
    }
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`response from ${url} is not JSON: ${text.slice(0, 300)}`);
    }
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`response from ${url} has no choices[0].message.content`);
    }
    const usage: Usage = { latencyMs: Math.round(performance.now() - started) };
    if (typeof raw?.usage?.prompt_tokens === "number") usage.inputTokens = raw.usage.prompt_tokens;
    if (typeof raw?.usage?.completion_tokens === "number") usage.outputTokens = raw.usage.completion_tokens;
    return { content, usage, raw };
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
