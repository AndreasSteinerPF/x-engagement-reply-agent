import { describe, expect, it } from "vitest";
import type { DraftReplyOutcome } from "../agent/draft-replies";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { InteractionResult } from "../x/interaction";
import type { ParsedPost } from "../x/parse-post";
import { buildParentTaskNotes, buildSubtaskNotes } from "./notes";

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

const ARTICLE: ArticleSimilarity = {
  rawScore: 0.8123,
  score: 82,
  title: "Web3 Property Ledgers",
  sourceUri: "https://x.com/i/article/1",
  excerpt: "excerpt",
  contextExcerpt: "context excerpt",
};

describe("buildParentTaskNotes", () => {
  const baseParams = {
    post: POST,
    interaction: { type: "original" as const },
    topArticles: [ARTICLE],
    asanaTaskSimilarityThreshold: 0,
    articleSimilarityThreshold: 0.7,
    bestCandidateRawScore: 0.8123,
  };

  it("includes source post, thresholds, and matched articles", () => {
    const notes = buildParentTaskNotes(baseParams);

    expect(notes).toContain(POST.sourceUri);
    expect(notes).toContain("Task creation threshold (raw similarity): 0.0000");
    expect(notes).toContain("Recommendation threshold (raw similarity): 0.7000");
    expect(notes).toContain("Best article match before thresholding: 0.8123");
    expect(notes).toContain("Web3 Property Ledgers");
    expect(notes).toContain("https://x.com/i/article/1");
  });

  it("shows '(none)' when there is no best candidate score", () => {
    const notes = buildParentTaskNotes({
      ...baseParams,
      bestCandidateRawScore: null,
      topArticles: [],
    });
    expect(notes).toContain("Best article match before thresholding: (none)");
    expect(notes).toContain("- none met the similarity threshold");
  });

  it("includes referenced-original details for a reply", () => {
    const interaction: InteractionResult = {
      type: "reply",
      referencedStatusId: "999",
      referencedAuthorHandle: "originalauthor",
    };
    const notes = buildParentTaskNotes({ ...baseParams, interaction });

    expect(notes).toContain("Type: post (reply)");
    expect(notes).toContain("Referenced original:");
    expect(notes).toContain("@originalauthor");
    expect(notes).toContain("999");
  });

  it("omits referenced-original section for an original post", () => {
    const notes = buildParentTaskNotes(baseParams);
    expect(notes).not.toContain("Referenced original:");
  });
});

describe("buildSubtaskNotes", () => {
  const successOutcome: DraftReplyOutcome = {
    ok: true,
    promptIndex: 1,
    promptLabel: "Prompt 1 -- Recommend and draft",
    promptText: "Draft a reply grounded in the article.",
    articleSourceUri: ARTICLE.sourceUri,
    articleTitle: ARTICLE.title,
    articleScore: ARTICLE.score,
    draft: {
      draftText: "Property records leaving silos is the thesis. What changes first?",
      quotedPhrase: "Property records leaving silos",
      whyRecommended: "Directly on-topic.",
    },
  };

  it("includes the draft text, prompt, article, and a compose link on success", () => {
    const notes = buildSubtaskNotes({ post: POST, article: ARTICLE, outcome: successOutcome });

    expect(notes).toContain(successOutcome.draft.draftText);
    expect(notes).toContain(successOutcome.promptLabel);
    expect(notes).toContain(successOutcome.promptText);
    expect(notes).toContain(successOutcome.draft.whyRecommended);
    expect(notes).toContain("Web3 Property Ledgers");
    expect(notes).toContain("Open in X:");
    expect(notes).toContain("https://twitter.com/intent/tweet?in_reply_to=123");
  });

  it("omits the compose link and shows the placeholder text on failure", () => {
    const failureOutcome: DraftReplyOutcome = {
      ok: false,
      promptIndex: 1,
      promptLabel: "Prompt 1 -- Recommend and draft",
      promptText: "Draft a reply grounded in the article.",
      articleSourceUri: ARTICLE.sourceUri,
      articleTitle: ARTICLE.title,
      articleScore: ARTICLE.score,
      placeholderText: "LLM generation failed for Prompt 1: quotedPhrase not grounded",
      reason: "quotedPhrase not grounded",
    };

    const notes = buildSubtaskNotes({ post: POST, article: ARTICLE, outcome: failureOutcome });

    expect(notes).toContain("LLM generation failed for Prompt 1");
    expect(notes).not.toContain("Open in X:");
    expect(notes).toContain("(draft generation failed)");
  });
});
