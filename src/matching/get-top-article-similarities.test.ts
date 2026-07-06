import { describe, expect, it, vi } from "vitest";
import { createCircuitBreaker } from "../mcp/circuit-breaker";
import type { InvestorMcpClient, QueryInvestorContentResponse } from "../mcp/investors-mcp-client";
import { getTopSoofiArticleSimilarities } from "./get-top-article-similarities";

function fakeMcpClient(overrides: Partial<InvestorMcpClient> = {}): InvestorMcpClient {
  return {
    queryInvestorContent: vi.fn(),
    listInvestorContent: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

const SAMPLE_RESPONSE: QueryInvestorContentResponse = {
  query: "post text",
  topK: 40,
  matchCount: 1,
  matches: [
    {
      id: "1",
      score: 0.9,
      key: "blob-key",
      metadata: {},
      blob: { sourceUri: "https://x.com/i/article/1", title: "Title", content: "content" },
    },
  ],
};

describe("getTopSoofiArticleSimilarities", () => {
  it("calls queryInvestorContent with the required Soofi-article query shape", async () => {
    const queryInvestorContent = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const mcpClient = fakeMcpClient({ queryInvestorContent });
    const breaker = createCircuitBreaker(3);

    await getTopSoofiArticleSimilarities({ mcpClient, breaker, postText: "post text", topK: 15 });

    expect(queryInvestorContent).toHaveBeenCalledWith({
      query: "post text",
      author: "Soofi Safavi",
      contentType: "article",
      segmentType: "article_full",
      topK: 15,
    });
  });

  it("clamps topK to 20 -- the live MCP server rejects anything higher, even though config allows up to 100", async () => {
    const queryInvestorContent = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const mcpClient = fakeMcpClient({ queryInvestorContent });
    const breaker = createCircuitBreaker(3);

    await getTopSoofiArticleSimilarities({ mcpClient, breaker, postText: "post text", topK: 40 });

    expect(queryInvestorContent).toHaveBeenCalledWith(expect.objectContaining({ topK: 20 }));
  });

  it("passes topK through unchanged when it is already at or below the server's cap", async () => {
    const queryInvestorContent = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const mcpClient = fakeMcpClient({ queryInvestorContent });
    const breaker = createCircuitBreaker(3);

    await getTopSoofiArticleSimilarities({ mcpClient, breaker, postText: "post text", topK: 20 });

    expect(queryInvestorContent).toHaveBeenCalledWith(expect.objectContaining({ topK: 20 }));
  });

  it("returns ok:true with ranked matches on success", async () => {
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
    });
    const breaker = createCircuitBreaker(3);

    const result = await getTopSoofiArticleSimilarities({
      mcpClient,
      breaker,
      postText: "post text",
      topK: 40,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].sourceUri).toBe("https://x.com/i/article/1");
    }
  });

  it("records a breaker success on a successful query, resetting its consecutive-failure count", async () => {
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
    });
    const breaker = createCircuitBreaker(2);
    breaker.recordFailure(); // 1 of 2 -- not yet tripped

    await getTopSoofiArticleSimilarities({ mcpClient, breaker, postText: "post text", topK: 40 });
    expect(breaker.isOpen()).toBe(false);

    // If the success above had reset the count, one more failure alone
    // should NOT trip a threshold-of-2 breaker.
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it("returns ok:false with reason mcp-query-failed and records a breaker failure on error", async () => {
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockRejectedValue(new Error("network blip")),
    });
    const breaker = createCircuitBreaker(3);

    const result = await getTopSoofiArticleSimilarities({
      mcpClient,
      breaker,
      postText: "post text",
      topK: 40,
    });

    expect(result).toEqual({ ok: false, reason: "mcp-query-failed", error: "network blip" });
    expect(breaker.isOpen()).toBe(false); // only 1 of 3 failures so far
  });

  it("skips the call entirely and returns mcp-circuit-open when the breaker is already open", async () => {
    const queryInvestorContent = vi.fn();
    const mcpClient = fakeMcpClient({ queryInvestorContent });
    const breaker = createCircuitBreaker(1);
    breaker.recordFailure(); // trips immediately (threshold 1)

    const result = await getTopSoofiArticleSimilarities({
      mcpClient,
      breaker,
      postText: "post text",
      topK: 40,
    });

    expect(result).toEqual({ ok: false, reason: "mcp-circuit-open" });
    expect(queryInvestorContent).not.toHaveBeenCalled();
  });

  it("times out a slow query and reports it as mcp-query-failed", async () => {
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const breaker = createCircuitBreaker(3);

    const result = await getTopSoofiArticleSimilarities({
      mcpClient,
      breaker,
      postText: "post text",
      topK: 40,
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "mcp-query-failed") {
      expect(result.error).toMatch(/timed out after 10ms/);
    }
  });
});
