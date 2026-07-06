import type { McpMatch } from "../mcp/investors-mcp-client";
import { normalizeWhitespace, truncateToHeader } from "../util/text";

export type ArticleSimilarity = {
  rawScore: number;
  score: number;
  title: string;
  sourceUri: string;
  excerpt: string;
  contextExcerpt: string;
};

function clampRelevanceScore(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 100) return 100;
  return rounded;
}

/**
 * Ported near-verbatim from investors-mcp's normalizeVectorScoreTo100.
 * Maps a raw vector-index similarity score -- typically cosine similarity
 * in [0,1] or [-1,1], but tolerant of a pre-scaled [1,100] input -- onto a
 * 1-100 display scale.
 */
export function normalizeVectorScoreTo100(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 1;
  if (rawScore >= 0 && rawScore <= 1) {
    return clampRelevanceScore(Math.round(1 + rawScore * 99));
  }
  if (rawScore >= -1 && rawScore <= 1) {
    return clampRelevanceScore(Math.round(1 + ((rawScore + 1) / 2) * 99));
  }
  if (rawScore > 1 && rawScore <= 100) {
    return clampRelevanceScore(Math.round(rawScore));
  }
  if (rawScore > 100) return 100;
  return 1;
}

/**
 * Gates PARENT TASK creation. `threshold <= 0` means "always create if
 * other checks pass" (matches config/settings.yaml's documented semantics
 * for asanaTaskSimilarityThreshold -- do not confuse with
 * meetsArticleThreshold below, which has no such always-allow case).
 */
export function meetsAsanaTaskThreshold(bestRawScore: number | null, threshold: number): boolean {
  if (threshold <= 0) return true;
  return bestRawScore !== null && bestRawScore >= threshold;
}

/**
 * Gates per-article RECOMMENDATION SUBTASK creation. Distinct from
 * meetsAsanaTaskThreshold -- see docs/config-schema.md, "Two thresholds".
 */
export function meetsArticleThreshold(rawScore: number, threshold: number): boolean {
  return rawScore >= threshold;
}

/**
 * Deduplicates MCP matches by sourceUri (keeping the highest-scoring one),
 * builds the display shape (title/excerpt/contextExcerpt/normalized score),
 * and returns the top `limit` by raw score descending. Ported near-verbatim
 * from investors-mcp's getTopSoofiArticleSimilarities body.
 */
export function selectTopArticleMatches(matches: McpMatch[], limit = 3): ArticleSimilarity[] {
  const bySource = new Map<string, ArticleSimilarity>();

  for (const match of matches) {
    const rawScore = Number.isFinite(match.score) ? match.score : 0;
    const sourceUri = normalizeWhitespace(
      match.blob?.sourceUri ?? String(match.metadata?.sourceUri ?? ""),
    );
    if (!sourceUri) continue;

    const content = normalizeWhitespace(match.blob?.content ?? "");
    const title =
      normalizeWhitespace(match.blob?.title ?? "") || truncateToHeader(content || sourceUri);
    const excerpt = content ? truncateToHeader(content, 320) : "";
    const contextExcerpt = content ? truncateToHeader(content, 1600) : excerpt;

    const key = sourceUri.toLowerCase();
    const existing = bySource.get(key);
    if (!existing || rawScore > existing.rawScore) {
      bySource.set(key, {
        rawScore,
        score: normalizeVectorScoreTo100(rawScore),
        title,
        sourceUri,
        excerpt,
        contextExcerpt,
      });
    }
  }

  return Array.from(bySource.values())
    .sort((a, b) => b.rawScore - a.rawScore)
    .slice(0, limit);
}
