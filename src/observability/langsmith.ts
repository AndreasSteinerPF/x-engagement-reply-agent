import * as ai from "ai";
import { Client } from "langsmith";
import { wrapAISDK } from "langsmith/experimental/vercel";
import type { RuntimeEnv } from "../config/env";
import { resolveSecret } from "../config/resolve-secret";

// Adapted from soofi-xyz-team-kit's observability-langsmith-telemetry.md.
// The reference facade wraps `ToolLoopAgent` (for the kit's inbound
// Asana-chat agents, which run multi-step tool loops). This agent has no
// tools and does single-shot structured generation per (article x prompt
// slot) -- see CLAUDE.md -- so the facade wraps `generateObject` instead.
// Every other rule (resolve key from Secrets Manager and cache it, pass the
// same Client to wrapAISDK and flush(), group traces by sessionId, degrade
// gracefully instead of failing the invocation) is unchanged.
export type LangSmithFacade = {
  tracingEnabled: boolean;
  generateObject: typeof ai.generateObject;
  flush: () => Promise<void>;
};

function tracingRequested(env: RuntimeEnv): boolean {
  return env.LANGSMITH_TRACING !== "false";
}

function passthroughFacade(): LangSmithFacade {
  return {
    tracingEnabled: false,
    generateObject: ai.generateObject,
    flush: async () => {},
  };
}

/**
 * Creates the traced generateObject facade. Never throws -- if tracing is
 * disabled or no API key is resolvable, returns the unwrapped AI SDK
 * function so a LangSmith outage never fails an agent invocation.
 */
export async function createLangSmithFacade(env: RuntimeEnv): Promise<LangSmithFacade> {
  if (!tracingRequested(env)) {
    return passthroughFacade();
  }

  const apiKey = await resolveSecret({
    plainValue: env.LANGSMITH_API_KEY,
    secretArn: env.LANGSMITH_API_KEY_SECRET_ARN,
    region: env.AWS_REGION,
  });
  if (!apiKey) {
    return passthroughFacade();
  }

  process.env.LANGSMITH_API_KEY = apiKey;
  process.env.LANGSMITH_ENDPOINT = env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com";
  if (env.LANGSMITH_PROJECT) {
    process.env.LANGSMITH_PROJECT = env.LANGSMITH_PROJECT;
  }
  process.env.LANGSMITH_TRACING = "true";

  const client = new Client();
  const wrapped = wrapAISDK(ai, { client });

  return {
    tracingEnabled: true,
    generateObject: wrapped.generateObject ?? ai.generateObject,
    flush: () => client.awaitPendingTraceBatches(),
  };
}
