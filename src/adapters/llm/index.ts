import type { ReplyGenerator } from "../../ports.js";
import { DeterministicReplyGenerator } from "./deterministic.js";
import { LlmReplyGenerator } from "./live.js";

export { DeterministicReplyGenerator } from "./deterministic.js";
export { LlmReplyGenerator } from "./live.js";

export interface ReplyGeneratorSelection {
  generator: ReplyGenerator;
  mode: "live" | "offline";
}

/**
 * Select a reply generator from the configured `modelId`. If the model names a
 * provider whose API key is present in the environment, use the live LLM;
 * otherwise fall back to the deterministic offline generator. Either way the run
 * is traced identically.
 */
export function createReplyGenerator(modelId: string): ReplyGeneratorSelection {
  const [providerRaw, ...rest] = modelId.split("/");
  const provider = providerRaw?.toLowerCase();
  const model = rest.join("/") || providerRaw || modelId;

  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return { generator: new LlmReplyGenerator({ provider: "openai", model, apiKey: process.env.OPENAI_API_KEY }), mode: "live" };
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return {
      generator: new LlmReplyGenerator({ provider: "anthropic", model, apiKey: process.env.ANTHROPIC_API_KEY }),
      mode: "live",
    };
  }
  return { generator: new DeterministicReplyGenerator(), mode: "offline" };
}
