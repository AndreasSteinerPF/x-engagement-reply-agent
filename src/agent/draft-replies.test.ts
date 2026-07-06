import { describe, expect, it, vi } from "vitest";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { LangSmithFacade } from "../observability/langsmith";
import type { ReplyPromptSlot } from "../prompts/load-prompts";
import type { ParsedPost } from "../x/parse-post";
import { generateDraftReplies, generateDraftReply, validateDraftReply } from "./draft-replies";
import type { DraftReply } from "./schemas";

const ARTICLE: ArticleSimilarity = {
  rawScore: 0.8,
  score: 82,
  title: "Web3 Property Ledgers",
  sourceUri: "https://x.com/i/article/1",
  excerpt: "Property records leaving silos is the whole thesis.",
  contextExcerpt:
    "Property records leaving silos is the whole thesis -- truth becomes programmable once ownership data is verifiable on-chain.",
};

const SLOT: ReplyPromptSlot = {
  promptIndex: 1,
  promptLabel: "Prompt 1 -- Recommend and draft",
  fileName: "01-recommend-and-draft.md",
  content: "Draft a reply grounded in the article.",
  endsWithQuestion: true,
};

const POST: ParsedPost = {
  statusId: "123",
  sourceUri: "https://x.com/exampleauthor/status/123",
  authorId: "1",
  authorHandle: "exampleauthor",
  header: "Example post",
  text: "Interesting take on property records.",
  contentType: "post",
  articleEnrichment: "not-applicable",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function draft(overrides: Partial<DraftReply> = {}): DraftReply {
  return {
    draftText: "Property records leaving silos is exactly the thesis. What changes first?",
    quotedPhrase: "Property records leaving silos is the whole thesis",
    whyRecommended: "Directly on-topic.",
    ...overrides,
  };
}

describe("validateDraftReply", () => {
  it("passes a well-formed, grounded, correctly-terminated draft", () => {
    expect(validateDraftReply(draft(), ARTICLE, SLOT, 280)).toEqual({ ok: true });
  });

  it("fails when the draft exceeds the character limit", () => {
    const result = validateDraftReply(
      draft({ draftText: "a".repeat(300) + "?" }),
      ARTICLE,
      SLOT,
      280,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/over the 280 limit/);
  });

  it("fails when quotedPhrase is not actually in the article excerpt", () => {
    const result = validateDraftReply(
      draft({ quotedPhrase: "something never said" }),
      ARTICLE,
      SLOT,
      280,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/does not appear verbatim/);
  });

  it("tolerates whitespace/case differences when matching quotedPhrase", () => {
    const result = validateDraftReply(
      draft({ quotedPhrase: "PROPERTY   records\nleaving silos" }),
      ARTICLE,
      SLOT,
      280,
    );
    expect(result.ok).toBe(true);
  });

  it("fails when the slot requires a question and the draft doesn't end with one", () => {
    const result = validateDraftReply(
      draft({ draftText: "Property records leaving silos." }),
      ARTICLE,
      SLOT,
      280,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/must end with a question/);
  });

  it("does not require a question when the slot opts out", () => {
    const noQuestionSlot: ReplyPromptSlot = { ...SLOT, endsWithQuestion: false };
    const withoutQuestion = draft({ draftText: "Property records leaving silos is the thesis." });

    expect(validateDraftReply(withoutQuestion, ARTICLE, noQuestionSlot, 280)).toEqual({ ok: true });
    // Sanity check: the same draft still fails against SLOT (endsWithQuestion: true).
    expect(validateDraftReply(withoutQuestion, ARTICLE, SLOT, 280).ok).toBe(false);
  });

  it("reports every violated reason at once", () => {
    const result = validateDraftReply(
      draft({ draftText: "a".repeat(300), quotedPhrase: "nope" }),
      ARTICLE,
      SLOT,
      280,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toHaveLength(3); // length, grounding, and question-ending all fail
    }
  });
});

function fakeLangsmith(generateObject: LangSmithFacade["generateObject"]): LangSmithFacade {
  return { tracingEnabled: true, generateObject, flush: vi.fn().mockResolvedValue(undefined) };
}

describe("generateDraftReply", () => {
  const baseParams = {
    model: {} as never,
    systemPrompt: "You draft replies.",
    constraints: "Max 280 chars.",
    maxReplyCharacters: 280,
    post: POST,
    article: ARTICLE,
    slot: SLOT,
    runKey: "run-123",
  };

  it("returns ok:true with the draft when the first attempt validates", async () => {
    const generateObject = vi.fn().mockResolvedValue({ object: draft() });
    const result = await generateDraftReply({
      ...baseParams,
      langsmith: fakeLangsmith(generateObject),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft).toEqual(draft());
      expect(result.promptLabel).toBe(SLOT.promptLabel);
      expect(result.promptText).toBe(SLOT.content);
      expect(result.articleSourceUri).toBe(ARTICLE.sourceUri);
    }
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("includes promptText (the prompt file's own instructions) even in a failure placeholder", async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValue({ object: draft({ quotedPhrase: "never said this" }) });
    const result = await generateDraftReply({
      ...baseParams,
      langsmith: fakeLangsmith(generateObject),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.promptText).toBe(SLOT.content);
    }
  });

  it("retries once with a stricter prompt and succeeds on the second attempt", async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValueOnce({ object: draft({ quotedPhrase: "not in the article" }) })
      .mockResolvedValueOnce({ object: draft() });

    const result = await generateDraftReply({
      ...baseParams,
      langsmith: fakeLangsmith(generateObject),
    });

    expect(result.ok).toBe(true);
    expect(generateObject).toHaveBeenCalledTimes(2);
    const secondCallArgs = generateObject.mock.calls[1][0];
    expect(secondCallArgs.prompt).toMatch(/Regenerate, strictly fixing/);
  });

  it("returns a visible placeholder after both attempts fail validation", async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValue({ object: draft({ quotedPhrase: "never said this" }) });

    const result = await generateDraftReply({
      ...baseParams,
      langsmith: fakeLangsmith(generateObject),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.placeholderText).toContain("LLM generation failed for");
      expect(result.placeholderText).toContain(SLOT.promptLabel);
      expect(result.reason).toMatch(/does not appear verbatim/);
    }
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("treats a generateObject rejection the same as a failed attempt and still retries", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("model timeout"))
      .mockResolvedValueOnce({ object: draft() });

    const result = await generateDraftReply({
      ...baseParams,
      langsmith: fakeLangsmith(generateObject),
    });

    expect(result.ok).toBe(true);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("includes session_id, prompt metadata, and Bedrock cache metadata in providerOptions.langsmith", async () => {
    const generateObject = vi.fn().mockResolvedValue({ object: draft() });
    await generateDraftReply({ ...baseParams, langsmith: fakeLangsmith(generateObject) });

    const callArgs = generateObject.mock.calls[0][0];
    const metadata = callArgs.providerOptions.langsmith.metadata;
    expect(metadata.session_id).toBe("run-123");
    expect(metadata.prompt_index).toBe(1);
    expect(metadata.prompt_label).toBe(SLOT.promptLabel);
    expect(metadata.article_source_uri).toBe(ARTICLE.sourceUri);
    expect(metadata.post_source_uri).toBe(POST.sourceUri);
    expect(metadata.bedrock_prompt_caching).toBe(true);
  });
});

describe("generateDraftReplies", () => {
  it("drafts one reply per (article x prompt slot) pair", async () => {
    const generateObject = vi.fn().mockResolvedValue({ object: draft() });
    const secondArticle: ArticleSimilarity = { ...ARTICLE, sourceUri: "https://x.com/i/article/2" };
    const secondSlot: ReplyPromptSlot = { ...SLOT, promptIndex: 2, fileName: "02-x.md" };

    const results = await generateDraftReplies({
      model: {} as never,
      langsmith: fakeLangsmith(generateObject),
      systemPrompt: "sys",
      constraints: "cons",
      maxReplyCharacters: 280,
      post: POST,
      articles: [ARTICLE, secondArticle],
      replySlots: [SLOT, secondSlot],
      runKey: "run-123",
    });

    expect(results).toHaveLength(4);
    expect(generateObject).toHaveBeenCalledTimes(4);
  });

  it("never exceeds the configured concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const generateObject = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { object: draft() };
    });

    const slots: ReplyPromptSlot[] = Array.from({ length: 6 }, (_, i) => ({
      ...SLOT,
      promptIndex: i + 1,
      fileName: `0${i + 1}-x.md`,
    }));

    await generateDraftReplies({
      model: {} as never,
      langsmith: fakeLangsmith(generateObject),
      systemPrompt: "sys",
      constraints: "cons",
      maxReplyCharacters: 280,
      post: POST,
      articles: [ARTICLE],
      replySlots: slots,
      runKey: "run-123",
      concurrency: 2,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
