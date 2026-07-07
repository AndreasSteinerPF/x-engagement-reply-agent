import { describe, it, expect } from "vitest";
import {
  composeIntentLink,
  buildAsanaRecommendationSubtaskNotes,
  subtaskName,
  parentTaskName,
} from "../src/adapters/asana/notes.js";
import type { ArticleRecommendation, SuggestedResponse } from "../src/ports.js";
import { makeArticle, makePost, makeWatchAuthor } from "./helpers.js";

describe("composeIntentLink", () => {
  it("contains in_reply_to=<statusId> and URL-encodes the text", () => {
    const link = composeIntentLink("123456789", "Hello & welcome to on-chain records!");
    expect(link).toContain("in_reply_to=123456789");
    // '&' and spaces inside text must be percent-encoded, not break the query string
    expect(link).toContain("text=Hello+%26+welcome");
    expect(link.startsWith("https://twitter.com/intent/tweet?")).toBe(true);
  });
});

describe("buildAsanaRecommendationSubtaskNotes", () => {
  const response: SuggestedResponse = {
    promptIndex: 1,
    promptLabel: "Recommend & Draft",
    prompt: "Recommend the article and draft a reply.",
    text: "Soofi's argument fits here: “records make ownership verifiable.” What breaks first?",
  };
  const recommendation: ArticleRecommendation = {
    ...makeArticle({ rawScore: 0.82, score100: 91 }),
    whyRecommended: "Both center on verifiable property records.",
    suggestedResponses: [response],
  };

  it("includes the draft text, the 'Similarity: raw=' line, and the intent link", () => {
    const notes = buildAsanaRecommendationSubtaskNotes({
      recommendation,
      post: makePost({ statusId: "999" }),
      response,
    });
    expect(notes).toContain(response.text);
    expect(notes).toContain("Similarity: raw=0.8200 | score=91");
    expect(notes).toContain(composeIntentLink("999", response.text));
    expect(notes).toContain("in_reply_to=999");
  });
});

describe("subtaskName", () => {
  const PREFIX = "Approve X Reply - ";
  it("truncates the '{label}: {title}' portion to <= 110 chars", () => {
    // NOTE: the source caps the inner `${label}: ${title}` segment at 110 — the
    // fixed "Approve X Reply - " prefix (18 chars) is added on top. So the inner
    // segment is what's bounded to 110, not the whole name.
    const longTitle = "A".repeat(200);
    const name = subtaskName("Recommend & Draft", longTitle);
    expect(name.startsWith(PREFIX)).toBe(true);
    const inner = name.slice(PREFIX.length);
    expect(inner.length).toBeLessThanOrEqual(110);
    // truncated with an ellipsis
    expect(inner.endsWith("…")).toBe(true);
  });
  it("leaves short names intact", () => {
    const name = subtaskName("P1", "Short Title");
    expect(name).toBe("Approve X Reply - P1: Short Title");
  });
});

describe("parentTaskName", () => {
  it("formats as 'Draft response: {author} - {header}'", () => {
    const name = parentTaskName(makeWatchAuthor({ author: "Balaji Srinivasan" }), makePost({ header: "On-chain records" }));
    expect(name).toBe("Draft response: Balaji Srinivasan - On-chain records");
  });
});
