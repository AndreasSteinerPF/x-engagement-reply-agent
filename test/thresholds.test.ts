import { describe, it, expect } from "vitest";
import {
  meetsArticleThreshold,
  meetsTaskThreshold,
  recommendedArticles,
  isExcludedAuthor,
} from "../src/pipeline/thresholds.js";
import { makeArticle } from "./helpers.js";

describe("meetsArticleThreshold", () => {
  it("requires rawScore >= threshold", () => {
    expect(meetsArticleThreshold(0.72, 0.72)).toBe(true);
    expect(meetsArticleThreshold(0.8, 0.72)).toBe(true);
    expect(meetsArticleThreshold(0.71, 0.72)).toBe(false);
  });
});

describe("meetsTaskThreshold", () => {
  it("threshold of 0 always allows", () => {
    expect(meetsTaskThreshold(0, 0)).toBe(true);
    expect(meetsTaskThreshold(0.01, 0)).toBe(true);
  });
  it("otherwise gates on bestRawScore >= threshold", () => {
    expect(meetsTaskThreshold(0.5, 0.6)).toBe(false);
    expect(meetsTaskThreshold(0.6, 0.6)).toBe(true);
  });
});

describe("recommendedArticles", () => {
  it("filters out articles below the threshold", () => {
    const articles = [
      makeArticle({ sourceUri: "a", rawScore: 0.8 }),
      makeArticle({ sourceUri: "b", rawScore: 0.72 }),
      makeArticle({ sourceUri: "c", rawScore: 0.5 }),
    ];
    const out = recommendedArticles(articles, 0.72);
    expect(out.map((a) => a.sourceUri)).toEqual(["a", "b"]);
  });
});

describe("isExcludedAuthor", () => {
  const exclude = ["soofisafavi", "ssafavi"];
  it("matches by normalized handle", () => {
    expect(isExcludedAuthor("ssafavi", exclude)).toBe(true);
    expect(isExcludedAuthor("@SSafavi", exclude)).toBe(true);
  });
  it("matches by display name normalization", () => {
    // "Soofi Safavi" normalizes to "soofisafavi" which is in the exclude list
    expect(isExcludedAuthor("Soofi Safavi", exclude)).toBe(true);
  });
  it("does not match an unrelated author", () => {
    expect(isExcludedAuthor("balajis", exclude)).toBe(false);
  });
});
