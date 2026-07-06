import type {
  LanguageModelV4,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBedrockPromptCaching, withBedrockPromptCaching } from "./bedrock-prompt-cache";

const logRuntime = vi.fn();
vi.mock("../observability/logger", () => ({
  logRuntime: (...args: unknown[]) => logRuntime(...args),
}));

function systemMessage(): LanguageModelV4Message {
  return { role: "system", content: "You are a helpful assistant." };
}

function userMessage(text: string): LanguageModelV4Message {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  logRuntime.mockReset();
});

describe("applyBedrockPromptCaching", () => {
  it("marks the first system message and the last non-system message", () => {
    const prompt: LanguageModelV4Prompt = [
      systemMessage(),
      userMessage("first"),
      userMessage("last"),
    ];

    const { prompt: result, cachePointsAdded } = applyBedrockPromptCaching(prompt);

    expect(cachePointsAdded).toBe(2);
    expect(result[0].providerOptions?.bedrock).toEqual({ cachePoint: { type: "default" } });
    expect(result[1].providerOptions?.bedrock).toBeUndefined();
    expect(result[2].providerOptions?.bedrock).toEqual({ cachePoint: { type: "default" } });
  });

  it("does not double-count when the only message is both first-system and last-non-system-eligible", () => {
    // Single system message, no non-system messages at all.
    const prompt: LanguageModelV4Prompt = [systemMessage()];
    const { cachePointsAdded, prompt: result } = applyBedrockPromptCaching(prompt);

    expect(cachePointsAdded).toBe(1);
    expect(result[0].providerOptions?.bedrock).toEqual({ cachePoint: { type: "default" } });
  });

  it("preserves existing provider options and only changes bedrock.cachePoint", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        ...systemMessage(),
        providerOptions: {
          bedrock: { reasoningConfig: { type: "enabled" } },
          anthropic: { foo: "bar" },
        },
      },
    ];

    const { prompt: result } = applyBedrockPromptCaching(prompt);

    expect(result[0].providerOptions?.bedrock).toEqual({
      reasoningConfig: { type: "enabled" },
      cachePoint: { type: "default" },
    });
    expect(result[0].providerOptions?.anthropic).toEqual({ foo: "bar" });
  });

  it("returns cachePointsAdded: 0 for an empty prompt", () => {
    const { cachePointsAdded } = applyBedrockPromptCaching([]);
    expect(cachePointsAdded).toBe(0);
  });
});

describe("withBedrockPromptCaching", () => {
  function fakeModel(overrides: Partial<LanguageModelV4> = {}): LanguageModelV4 {
    return {
      specificationVersion: "v4",
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
      ...overrides,
    } as unknown as LanguageModelV4;
  }

  it("injects cache points into the prompt before calling the underlying model", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 } },
      warnings: [],
    });
    const model = withBedrockPromptCaching(fakeModel({ doGenerate }));

    await model.doGenerate({
      prompt: [systemMessage(), userMessage("hi")],
    } as Parameters<LanguageModelV4["doGenerate"]>[0]);

    const calledWith = doGenerate.mock.calls[0][0];
    expect(calledWith.prompt[0].providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    });
    expect(calledWith.prompt[1].providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    });
  });

  it("logs cache read/write tokens from a generate response", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 } },
      warnings: [],
    });
    const model = withBedrockPromptCaching(fakeModel({ doGenerate }));

    await model.doGenerate({ prompt: [userMessage("hi")] } as Parameters<
      LanguageModelV4["doGenerate"]
    >[0]);

    expect(logRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        bedrockPromptCacheReadInputTokens: 50,
        bedrockPromptCacheWriteInputTokens: 10,
      }),
    );
  });

  it("does not log when there is no cache read or write activity", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [],
      finishReason: "stop",
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 } },
      warnings: [],
    });
    const model = withBedrockPromptCaching(fakeModel({ doGenerate }));

    await model.doGenerate({ prompt: [userMessage("hi")] } as Parameters<
      LanguageModelV4["doGenerate"]
    >[0]);

    expect(logRuntime).not.toHaveBeenCalled();
  });

  it("logs cache usage from a stream's finish chunk without altering other chunks", async () => {
    const chunks = [
      { type: "text-delta", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: { total: 20, noCache: 5, cacheRead: 15, cacheWrite: 0 } },
      },
    ];
    const doStream = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    const model = withBedrockPromptCaching(fakeModel({ doStream }));

    const result = await model.doStream({ prompt: [userMessage("hi")] } as Parameters<
      LanguageModelV4["doStream"]
    >[0]);

    const seen: unknown[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value);
    }

    expect(seen).toEqual(chunks);
    expect(logRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        bedrockPromptCacheReadInputTokens: 15,
        bedrockPromptCacheWriteInputTokens: 0,
      }),
    );
  });
});
