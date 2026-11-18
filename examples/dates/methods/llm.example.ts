// How a method calls a model. Rename to llm.ts to use it; it needs
// EVALBENCH_BASE_URL, EVALBENCH_API_KEY and EVALBENCH_MODEL.
import type { MethodContext } from "../../../src/index.ts";

export default async function run(input: string, ctx: MethodContext) {
  const reply = await ctx.chat({
    temperature: 0,
    messages: [
      { role: "system", content: "Reply with the date in the sentence as YYYY-MM-DD and nothing else." },
      { role: "user", content: input },
    ],
    signal: ctx.signal,
  });
  return { output: reply.content.trim(), usage: reply.usage };
}
