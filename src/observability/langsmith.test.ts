import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(function FakeSecretsManagerClient() {
    return { send: mockSend };
  }),
  GetSecretValueCommand: vi.fn().mockImplementation(function FakeCommand(input: unknown) {
    return { input };
  }),
}));

const mockAwaitPendingTraceBatches = vi.fn();
vi.mock("langsmith", () => ({
  Client: vi.fn().mockImplementation(function FakeClient() {
    return { awaitPendingTraceBatches: mockAwaitPendingTraceBatches };
  }),
}));

const wrappedGenerateObject = vi.fn();
const mockWrapAISDK = vi.fn().mockReturnValue({ generateObject: wrappedGenerateObject });
vi.mock("langsmith/experimental/vercel", () => ({
  wrapAISDK: (...args: unknown[]) => mockWrapAISDK(...args),
}));

import * as ai from "ai";
import { createLangSmithFacade } from "./langsmith";

// Secret caching (a single warm Lambda container should only fetch a given
// ARN once) now lives in src/config/resolve-secret.ts, keyed per-ARN -- see
// resolve-secret.test.ts for that behavior directly.
const BASE_ENV = { AWS_REGION: "us-east-2" };

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({ SecretString: "secret-from-sm" });
  mockAwaitPendingTraceBatches.mockReset().mockResolvedValue(undefined);
  mockWrapAISDK.mockClear();
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_PROJECT;
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_ENDPOINT;
});

describe("createLangSmithFacade", () => {
  it("returns the unwrapped generateObject when tracing is explicitly disabled", async () => {
    const facade = await createLangSmithFacade({ ...BASE_ENV, LANGSMITH_TRACING: "false" });

    expect(facade.tracingEnabled).toBe(false);
    expect(facade.generateObject).toBe(ai.generateObject);
    await expect(facade.flush()).resolves.toBeUndefined();
    expect(mockWrapAISDK).not.toHaveBeenCalled();
  });

  it("degrades gracefully to the unwrapped function when no API key is resolvable", async () => {
    const facade = await createLangSmithFacade({ ...BASE_ENV });

    expect(facade.tracingEnabled).toBe(false);
    expect(facade.generateObject).toBe(ai.generateObject);
  });

  it("uses LANGSMITH_API_KEY directly when provided", async () => {
    const facade = await createLangSmithFacade({ ...BASE_ENV, LANGSMITH_API_KEY: "direct-key" });

    expect(facade.tracingEnabled).toBe(true);
    expect(facade.generateObject).toBe(wrappedGenerateObject);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("resolves the API key from Secrets Manager when only the ARN is provided, and caches it across calls", async () => {
    const env = {
      ...BASE_ENV,
      LANGSMITH_API_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-2:123:secret:langsmith",
    };

    const facade = await createLangSmithFacade(env);
    expect(facade.tracingEnabled).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // A second facade creation (e.g. a later invocation in the same warm
    // Lambda container) must reuse the cached key rather than re-fetching.
    await createLangSmithFacade(env);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("calls flush through to the underlying LangSmith client", async () => {
    const facade = await createLangSmithFacade({ ...BASE_ENV, LANGSMITH_API_KEY: "direct-key" });

    await facade.flush();

    expect(mockAwaitPendingTraceBatches).toHaveBeenCalledTimes(1);
  });

  it("sets LANGSMITH_PROJECT only when provided, and always sets an endpoint default", async () => {
    await createLangSmithFacade({ ...BASE_ENV, LANGSMITH_API_KEY: "direct-key" });

    expect(process.env.LANGSMITH_ENDPOINT).toBe("https://api.smith.langchain.com");
    expect(process.env.LANGSMITH_PROJECT).toBeUndefined();

    await createLangSmithFacade({
      ...BASE_ENV,
      LANGSMITH_API_KEY: "direct-key",
      LANGSMITH_PROJECT: "x-engagement-reply-agent",
    });

    expect(process.env.LANGSMITH_PROJECT).toBe("x-engagement-reply-agent");
  });
});
