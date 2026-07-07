import { describe, it, expect } from "vitest";
import { parsePythonLiteral, coerceRecord } from "../src/mcp/parse.js";
import { collapseDuplicates, rawToDisplayScore } from "../src/similarity.js";
import type { RawMatch } from "../src/mcp/client.js";

describe("parsePythonLiteral", () => {
  it("parses a python dict literal with single quotes, apostrophe, True/False/None, nested list", () => {
    const input =
      "{'sourceUri': 'https://x/1', 'title': \"It's a test\", " +
      "'active': True, 'archived': False, 'deletedAt': None, " +
      "'tags': ['a', 'b', 'c'], 'count': 3}";
    const out = parsePythonLiteral(input) as Record<string, unknown>;
    expect(out).toEqual({
      sourceUri: "https://x/1",
      title: "It's a test",
      active: true,
      archived: false,
      deletedAt: null,
      tags: ["a", "b", "c"],
      count: 3,
    });
  });

  it("returns undefined for unparseable input", () => {
    expect(parsePythonLiteral("{not: valid")).toBeUndefined();
  });
});

describe("coerceRecord", () => {
  it("returns an already-object value unchanged", () => {
    const obj = { sourceUri: "u", n: 1 };
    expect(coerceRecord(obj)).toEqual(obj);
  });

  it("parses a JSON string", () => {
    expect(coerceRecord('{"sourceUri":"u","n":1}')).toEqual({ sourceUri: "u", n: 1 });
  });

  it("parses a python-literal string", () => {
    expect(coerceRecord("{'sourceUri': 'u', 'flag': True}")).toEqual({ sourceUri: "u", flag: true });
  });

  it("returns {} for arrays / unparseable input", () => {
    expect(coerceRecord([1, 2, 3])).toEqual({});
    expect(coerceRecord("not a record")).toEqual({});
  });
});

describe("rawToDisplayScore", () => {
  it("maps raw 0.82 -> 91", () => {
    expect(rawToDisplayScore(0.82)).toBe(91);
  });
  it("clamps into [1,100]", () => {
    expect(rawToDisplayScore(-5)).toBe(1);
    expect(rawToDisplayScore(5)).toBe(100);
  });
});

describe("collapseDuplicates", () => {
  /** Build a RawMatch whose blob is a python-literal string. */
  function rawMatch(score: number, sourceUri: string, title: string, content = "some article content"): RawMatch {
    const blob = `{'sourceUri': '${sourceUri}', 'title': '${title}', 'content': '${content}'}`;
    return { id: `${sourceUri}-${score}`, key: "k", score, metadata: "{}", blob };
  }

  it("collapses duplicate sourceUri keeping the highest score, returns <=3 sorted desc", () => {
    const matches: RawMatch[] = [
      rawMatch(0.5, "uri-a", "A low"),
      rawMatch(0.9, "uri-a", "A high"), // duplicate of uri-a, higher
      rawMatch(0.8, "uri-b", "B"),
      rawMatch(0.7, "uri-c", "C"),
      rawMatch(0.6, "uri-d", "D"), // 4th distinct -> dropped (max 3)
    ];
    const out = collapseDuplicates(matches);

    expect(out).toHaveLength(3);
    expect(out.map((a) => a.sourceUri)).toEqual(["uri-a", "uri-b", "uri-c"]);
    // uri-a kept the higher score and title
    expect(out[0]!.rawScore).toBe(0.9);
    expect(out[0]!.title).toBe("A high");
    // descending order
    expect(out[0]!.rawScore).toBeGreaterThan(out[1]!.rawScore);
    expect(out[1]!.rawScore).toBeGreaterThan(out[2]!.rawScore);
    // score100 derived
    expect(out[1]!.score100).toBe(rawToDisplayScore(0.8));
  });

  it("skips matches without a sourceUri", () => {
    const noUri: RawMatch = { id: "x", key: "k", score: 0.99, metadata: "{}", blob: "{'title': 'no uri'}" };
    const out = collapseDuplicates([noUri]);
    expect(out).toEqual([]);
  });
});
