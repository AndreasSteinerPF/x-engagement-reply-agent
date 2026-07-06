import { describe, expect, it } from "vitest";
import { normalizeWhitespace, truncateToHeader } from "./text";

describe("normalizeWhitespace", () => {
  it("collapses internal whitespace and trims", () => {
    expect(normalizeWhitespace("  a   b\n\nc  ")).toBe("a b c");
  });
});

describe("truncateToHeader", () => {
  it("returns short text unchanged", () => {
    expect(truncateToHeader("Short text")).toBe("Short text");
  });

  it("truncates long text at a word boundary with an ellipsis", () => {
    const longText =
      "This is a fairly long piece of text that should be truncated at a sensible word boundary rather than mid-word.";
    const result = truncateToHeader(longText, 40);
    expect(result.length).toBeLessThanOrEqual(44);
    expect(result.endsWith("...")).toBe(true);
    expect(result).not.toContain("  ");
  });

  it("collapses internal whitespace before measuring length", () => {
    expect(truncateToHeader("a   b\n\nc")).toBe("a b c");
  });

  it("falls back to a hard cut when there is no space before the halfway point", () => {
    const result = truncateToHeader("A".repeat(120), 80);
    expect(result).toBe(`${"A".repeat(80)}...`);
  });
});
