import { describe, expect, it } from "vitest";
import type { McpMatch } from "../mcp/investors-mcp-client";
import {
  meetsArticleThreshold,
  meetsAsanaTaskThreshold,
  normalizeVectorScoreTo100,
  selectTopArticleMatches,
} from "./similarity-gating";

function match(overrides: Partial<McpMatch> & { score: number }): McpMatch {
  return {
    id: "id",
    key: "key",
    metadata: {},
    blob: null,
    ...overrides,
  };
}

describe("normalizeVectorScoreTo100", () => {
  it("maps a [0,1] cosine-like score linearly onto 1-100", () => {
    expect(normalizeVectorScoreTo100(0)).toBe(1);
    expect(normalizeVectorScoreTo100(1)).toBe(100);
    expect(normalizeVectorScoreTo100(0.5)).toBe(Math.round(1 + 0.5 * 99));
  });

  it("maps a negative score in [-1,0) onto the low end of 1-100", () => {
    expect(normalizeVectorScoreTo100(-1)).toBe(1);
    // -0.5 -> 1 + ((−0.5+1)/2)*99 = 1 + 0.25*99 ≈ 25.75 -> 26
    expect(normalizeVectorScoreTo100(-0.5)).toBe(26);
  });

  it("rounds a pre-scaled score in (1,100] directly", () => {
    expect(normalizeVectorScoreTo100(73.4)).toBe(73);
  });

  it("clamps anything above 100 to 100", () => {
    expect(normalizeVectorScoreTo100(150)).toBe(100);
  });

  it("returns 1 for non-finite input", () => {
    expect(normalizeVectorScoreTo100(Number.NaN)).toBe(1);
    expect(normalizeVectorScoreTo100(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("meetsAsanaTaskThreshold", () => {
  it("always allows when the threshold is 0", () => {
    expect(meetsAsanaTaskThreshold(null, 0)).toBe(true);
    expect(meetsAsanaTaskThreshold(0.01, 0)).toBe(true);
  });

  it("rejects when there is no candidate score and the threshold is above 0", () => {
    expect(meetsAsanaTaskThreshold(null, 0.5)).toBe(false);
  });

  it("compares the best raw score against the threshold", () => {
    expect(meetsAsanaTaskThreshold(0.5, 0.5)).toBe(true);
    expect(meetsAsanaTaskThreshold(0.49, 0.5)).toBe(false);
  });
});

describe("meetsArticleThreshold", () => {
  it("has no always-allow case at 0 (unlike meetsAsanaTaskThreshold)", () => {
    expect(meetsArticleThreshold(0, 0)).toBe(true);
    expect(meetsArticleThreshold(-0.1, 0)).toBe(false);
  });

  it("compares the raw score against the threshold", () => {
    expect(meetsArticleThreshold(0.7, 0.7)).toBe(true);
    expect(meetsArticleThreshold(0.69, 0.7)).toBe(false);
  });
});

describe("selectTopArticleMatches", () => {
  it("builds title/excerpt/contextExcerpt from blob content, falling back to sourceUri", () => {
    const matches: McpMatch[] = [
      match({
        score: 0.9,
        blob: { sourceUri: "https://x.com/i/article/1", title: "Title", content: "A".repeat(50) },
      }),
    ];

    const [result] = selectTopArticleMatches(matches);
    expect(result.sourceUri).toBe("https://x.com/i/article/1");
    expect(result.title).toBe("Title");
    expect(result.excerpt).toBe("A".repeat(50));
    expect(result.score).toBe(normalizeVectorScoreTo100(0.9));
  });

  it("falls back to metadata.sourceUri when the blob is missing", () => {
    const matches: McpMatch[] = [
      match({ score: 0.5, blob: null, metadata: { sourceUri: "https://x.com/i/article/2" } }),
    ];
    const [result] = selectTopArticleMatches(matches);
    expect(result.sourceUri).toBe("https://x.com/i/article/2");
    expect(result.excerpt).toBe("");
  });

  it("skips matches with no resolvable sourceUri", () => {
    const matches: McpMatch[] = [match({ score: 0.9, blob: null, metadata: {} })];
    expect(selectTopArticleMatches(matches)).toEqual([]);
  });

  it("dedupes by sourceUri, keeping the highest-scoring match", () => {
    const matches: McpMatch[] = [
      match({
        id: "a",
        score: 0.4,
        blob: { sourceUri: "https://x.com/i/article/1", content: "low" },
      }),
      match({
        id: "b",
        score: 0.9,
        blob: { sourceUri: "https://x.com/i/article/1", content: "high" },
      }),
    ];
    const result = selectTopArticleMatches(matches);
    expect(result).toHaveLength(1);
    expect(result[0].rawScore).toBe(0.9);
    expect(result[0].excerpt).toBe("high");
  });

  it("dedupes sourceUri case-insensitively", () => {
    const matches: McpMatch[] = [
      match({ id: "a", score: 0.4, blob: { sourceUri: "https://x.com/i/Article/1" } }),
      match({ id: "b", score: 0.6, blob: { sourceUri: "https://x.com/i/article/1" } }),
    ];
    expect(selectTopArticleMatches(matches)).toHaveLength(1);
  });

  it("sorts by raw score descending and slices to the limit", () => {
    const matches: McpMatch[] = [
      match({ id: "a", score: 0.3, blob: { sourceUri: "https://x.com/i/article/a" } }),
      match({ id: "b", score: 0.9, blob: { sourceUri: "https://x.com/i/article/b" } }),
      match({ id: "c", score: 0.6, blob: { sourceUri: "https://x.com/i/article/c" } }),
    ];
    const result = selectTopArticleMatches(matches, 2);
    expect(result.map((r) => r.sourceUri)).toEqual([
      "https://x.com/i/article/b",
      "https://x.com/i/article/c",
    ]);
  });

  it("treats a non-finite score as 0 rather than throwing", () => {
    const matches: McpMatch[] = [
      match({ score: Number.NaN, blob: { sourceUri: "https://x.com/i/article/1" } }),
    ];
    const [result] = selectTopArticleMatches(matches);
    expect(result.rawScore).toBe(0);
  });
});
