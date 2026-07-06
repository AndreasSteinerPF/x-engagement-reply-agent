import type { CircuitBreaker } from "../mcp/circuit-breaker";
import type { InvestorMcpClient } from "../mcp/investors-mcp-client";
import { withTimeout } from "../util/with-timeout";
import { selectTopArticleMatches, type ArticleSimilarity } from "./similarity-gating";

const SOOFI_AUTHOR = "Soofi Safavi";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 3;

// The README's "Required RAG integration" example calls queryInvestorContent
// with topK: 40, but the LIVE hosted MCP server's own input schema caps
// topK at 20 and rejects anything higher with a non-JSON validation error
// (verified empirically against https://investors-mcp.vercel.app/mcp on
// 2026-07-06 -- topK: 21+ returns `isError: true` with body
// "MCP error -32602: Input validation error..."). config/settings.yaml's
// defaultTopK can still go up to 100 as a business-level "how many
// candidates to consider" knob; this clamp is the integration boundary
// that keeps every actual request within what the live server accepts.
const MCP_SERVER_TOP_K_MAX = 20;

export type GetTopArticleSimilaritiesParams = {
  mcpClient: InvestorMcpClient;
  breaker: CircuitBreaker;
  postText: string;
  topK: number;
  timeoutMs?: number;
  limit?: number;
};

export type GetTopArticleSimilaritiesResult =
  | { ok: true; matches: ArticleSimilarity[] }
  | { ok: false; reason: "mcp-circuit-open" }
  | { ok: false; reason: "mcp-query-failed"; error: string };

/**
 * Matches a post against Soofi Safavi's article corpus via the required
 * hosted-MCP query shape (README "Required RAG integration"), then dedupes
 * and ranks the results. Isolates failures per-post: a query failure or
 * timeout never throws out of this function -- it returns a tagged skip
 * result so the caller can record `skip-reason: mcp-query-failed` and
 * continue the batch (per docs/implementation-plan.md).
 */
export async function getTopSoofiArticleSimilarities(
  params: GetTopArticleSimilaritiesParams,
): Promise<GetTopArticleSimilaritiesResult> {
  if (params.breaker.isOpen()) {
    return { ok: false, reason: "mcp-circuit-open" };
  }

  try {
    const response = await withTimeout(
      params.mcpClient.queryInvestorContent({
        query: params.postText,
        author: SOOFI_AUTHOR,
        contentType: "article",
        segmentType: "article_full",
        topK: Math.min(params.topK, MCP_SERVER_TOP_K_MAX),
      }),
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "queryInvestorContent",
    );
    params.breaker.recordSuccess();
    return {
      ok: true,
      matches: selectTopArticleMatches(response.matches, params.limit ?? DEFAULT_LIMIT),
    };
  } catch (error) {
    params.breaker.recordFailure();
    return {
      ok: false,
      reason: "mcp-query-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
