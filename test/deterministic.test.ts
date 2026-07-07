import { describe, it, expect } from "vitest";
import { DeterministicReplyGenerator } from "../src/adapters/llm/deterministic.js";
import type { ReplyGenerationInput } from "../src/ports.js";
import { makeArticle, makePost, ARTICLE_EXCERPT } from "./helpers.js";

describe("DeterministicReplyGenerator", () => {
  const gen = new DeterministicReplyGenerator();

  /** Five prompt slots, one with requireQuestion:false. */
  const prompts: ReplyGenerationInput["prompts"] = [
    { index: 1, label: "Recommend & Draft", text: "Recommend the article and draft a grounded reply.", requireQuestion: true },
    { index: 2, label: "Agree & Extend", text: "Agree and extend the article's point.", requireQuestion: true },
    { index: 3, label: "Respectful Counter", text: "Respectfully counter or qualify the claim.", requireQuestion: true },
    { index: 4, label: "Concrete Example", text: "Give a concrete, tangible mechanism or example.", requireQuestion: true },
    { index: 5, label: "Call To Action", text: "Close with a call to action, no question.", requireQuestion: false },
  ];

  const input: ReplyGenerationInput = {
    post: makePost(),
    article: makeArticle({ contextExcerpt: ARTICLE_EXCERPT }),
    systemPrompt: "system prompt",
    responseConstraints: ["Maximum of 280 characters.", "Use short sentences."],
    prompts,
  };

  it("produces one response per prompt, each <= 280 chars, each quoting article text", async () => {
    const out = await gen.generate(input);
    expect(out.responses).toHaveLength(prompts.length);
    for (const r of out.responses) {
      expect(r.text.length).toBeLessThanOrEqual(280);
      // every reply quotes a phrase from the article (curly opening quote)
      expect(r.text).toContain("“");
    }
  });

  it("quotes a phrase actually drawn from the article excerpt", async () => {
    const out = await gen.generate(input);
    // Extract the quoted phrase from the first reply and assert it is a substring of the source.
    const quoted = out.responses[0]!.text.match(/“([^”]+)”/)?.[1];
    expect(quoted).toBeTruthy();
    const cleaned = quoted!.replace(/…$/, "").replace(/\.$/, "");
    expect(ARTICLE_EXCERPT).toContain(cleaned);
  });

  it("requireQuestion:true prompts end with '?'; requireQuestion:false does NOT", async () => {
    const out = await gen.generate(input);
    for (const r of out.responses.slice(0, 4)) {
      expect(r.text.trim().endsWith("?")).toBe(true);
    }
    const cta = out.responses[4]!;
    expect(cta.promptLabel).toBe("Call To Action");
    expect(cta.text.trim().endsWith("?")).toBe(false);
  });

  it("different prompt slots can produce different opener text", async () => {
    const out = await gen.generate(input);
    const openers = new Set(out.responses.map((r) => r.text.split("“")[0]!.trim()));
    // recommend / agree / counter / example produce distinct openers
    expect(openers.size).toBeGreaterThan(1);
  });

  it("trace.ok === true and trace.promptCount matches prompt count", async () => {
    const out = await gen.generate(input);
    expect(out.trace.ok).toBe(true);
    expect(out.trace.promptCount).toBe(prompts.length);
    expect(out.trace.provider).toBe("offline-deterministic");
    expect(out.whyRecommended.length).toBeGreaterThan(0);
  });
});
