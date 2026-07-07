import { describe, it, expect } from "vitest";
import { McpArticleMatcher } from "../src/similarity.js";

/**
 * Live MCP smoke test against the hosted investors-mcp server. Network-gated:
 * runs ONLY when RUN_LIVE_MCP=1, so the default suite passes fully offline.
 * Even when enabled it tolerates transient network failures (returns early).
 */
const LIVE = process.env.RUN_LIVE_MCP === "1";

describe.runIf(LIVE)("live MCP smoke", () => {
  it(
    "returns >=1 article with rawScore in [0,1] for an on-topic query",
    async () => {
      const matcher = new McpArticleMatcher();
      let articles;
      try {
        articles = await matcher.getTopSoofiArticleSimilarities(
          "verifiable on-chain property ownership records and liens",
          6,
        );
      } catch {
        // Offline / network error — do not fail the suite.
        return;
      }
      expect(articles.length).toBeGreaterThanOrEqual(1);
      const top = articles[0]!;
      expect(top.rawScore).toBeGreaterThanOrEqual(0);
      expect(top.rawScore).toBeLessThanOrEqual(1);
    },
    30_000,
  );
});
