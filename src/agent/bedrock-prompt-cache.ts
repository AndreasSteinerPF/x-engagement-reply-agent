import type {
  LanguageModelV4,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { logRuntime } from "../observability/logger";

// Ported from soofi-xyz-team-kit's implementation-bedrock-prompt-caching.md,
// adapted for the installed AI SDK/provider version: the rule doc's
// reference implementation targets LanguageModel spec v3, but the installed
// @ai-sdk/amazon-bedrock (5.x) returns v4 models -- verified against the
// actual installed package rather than assumed from the doc. The cache
// strategy (system + last non-system message) and usage-token field names
// (usage.inputTokens.cacheRead/cacheWrite) are unchanged between v3 and v4.

const BEDROCK_CACHE_POINT = { type: "default" as const };

export const BEDROCK_PROMPT_CACHE_METADATA = {
  bedrock_prompt_caching: true,
  bedrock_prompt_cache_strategy: "system_and_last_non_system",
  bedrock_prompt_cache_ttl: "default",
  bedrock_prompt_cache_tool_config: false,
} as const;

function withCachePoint(message: LanguageModelV4Message): LanguageModelV4Message {
  const providerOptions = message.providerOptions ?? {};
  const bedrockOptions =
    typeof providerOptions.bedrock === "object" && providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};

  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      bedrock: {
        ...bedrockOptions,
        cachePoint: BEDROCK_CACHE_POINT,
      },
    },
  } as LanguageModelV4Message;
}

export function applyBedrockPromptCaching(prompt: LanguageModelV4Prompt): {
  prompt: LanguageModelV4Prompt;
  cachePointsAdded: number;
} {
  const targetIndexes = new Set<number>();
  const firstSystemIndex = prompt.findIndex((message) => message.role === "system");
  if (firstSystemIndex >= 0) {
    targetIndexes.add(firstSystemIndex);
  }

  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== "system") {
      targetIndexes.add(index);
      break;
    }
  }

  if (targetIndexes.size === 0) {
    return { prompt, cachePointsAdded: 0 };
  }

  return {
    prompt: prompt.map((message, index) =>
      targetIndexes.has(index) ? withCachePoint(message) : message,
    ),
    cachePointsAdded: targetIndexes.size,
  };
}

function logCacheUsage(
  usage: { inputTokens: { cacheRead?: number; cacheWrite?: number } } | undefined,
): void {
  const cacheRead = usage?.inputTokens.cacheRead ?? 0;
  const cacheWrite = usage?.inputTokens.cacheWrite ?? 0;

  if (cacheRead <= 0 && cacheWrite <= 0) {
    return;
  }

  logRuntime({
    level: "info",
    message: "Bedrock prompt cache usage.",
    bedrockPromptCacheReadInputTokens: cacheRead,
    bedrockPromptCacheWriteInputTokens: cacheWrite,
  });
}

/**
 * Wraps a Bedrock language model with prompt-cache middleware. Apply this
 * immediately after `bedrock(modelId)` and before passing the model to
 * `generateObject`/`generateText` -- never pass the raw Bedrock model
 * through, or cache points are silently never added.
 */
export function withBedrockPromptCaching(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        prompt: applyBedrockPromptCaching(params.prompt).prompt,
      }),
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        logCacheUsage(result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") {
                logCacheUsage(chunk.usage);
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  }) as LanguageModelV4;
}
