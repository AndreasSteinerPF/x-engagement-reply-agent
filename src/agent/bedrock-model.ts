import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { RuntimeEnv } from "../config/env";
import { withBedrockPromptCaching } from "./bedrock-prompt-cache";

/**
 * Builds the Bedrock model used for reply drafting, already wrapped with
 * prompt-cache middleware. `modelId` comes from config/settings.yaml (a
 * business decision, code-managed per CLAUDE.md), not from an env var --
 * only the AWS region/credentials are environment-level.
 *
 * Never pass the raw `bedrock(modelId)` model to generateObject -- always
 * go through this function so prompt caching is never accidentally skipped.
 */
export function createDraftingModel(modelId: string, env: RuntimeEnv): LanguageModelV4 {
  const bedrock = createAmazonBedrock({
    region: env.AWS_REGION,
    credentialProvider: fromNodeProviderChain(),
  });

  return withBedrockPromptCaching(bedrock(modelId));
}
