import { describe, expect, it } from "vitest";
import { parsePost } from "./parse-post";
import type { RawTweet } from "./types";

describe("parsePost", () => {
  const baseTweet: RawTweet = {
    id: "1234567890123456789",
    text: "A plain post about decentralized property data.",
    author_id: "42",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("builds sourceUri from the author handle and status id", () => {
    const result = parsePost(baseTweet, "exampleauthor");
    expect(result.sourceUri).toBe("https://x.com/exampleauthor/status/1234567890123456789");
    expect(result.statusId).toBe("1234567890123456789");
    expect(result.authorHandle).toBe("exampleauthor");
    expect(result.authorId).toBe("42");
  });

  it("treats a plain post with no article/note_tweet as contentType 'post' and articleEnrichment 'not-applicable'", () => {
    const result = parsePost(baseTweet, "exampleauthor");
    expect(result.contentType).toBe("post");
    expect(result.articleEnrichment).toBe("not-applicable");
    expect(result.text).toBe(baseTweet.text);
    expect(result.header).toBe(baseTweet.text);
  });

  it("uses note_tweet long-form text when it is longer than the plain text", () => {
    const tweet: RawTweet = {
      ...baseTweet,
      text: "Short preview...",
      note_tweet: {
        text: "A much longer piece of long-form Note content that expands on the short preview text.",
      },
    };
    const result = parsePost(tweet, "exampleauthor");
    expect(result.text).toBe(tweet.note_tweet?.text);
    expect(result.contentType).toBe("post");
    expect(result.articleEnrichment).toBe("not-applicable");
  });

  it("marks articleEnrichment 'available' when the article field has a meaningfully longer body", () => {
    const tweet: RawTweet = {
      ...baseTweet,
      text: "Short preview of an article.",
      article: {
        title: "Full Article Title",
        preview_text:
          "This is the full article body, which is considerably longer than the short tweet preview text and should be treated as meaningfully enriched content.",
      },
    };
    const result = parsePost(tweet, "exampleauthor");
    expect(result.contentType).toBe("article");
    expect(result.articleEnrichment).toBe("available");
    expect(result.header).toBe("Full Article Title");
    expect(result.text).toBe(tweet.article?.preview_text);
  });

  it("marks articleEnrichment 'unavailable' when the article field exists but adds no meaningful content", () => {
    const tweet: RawTweet = {
      ...baseTweet,
      text: "This is the tweet text standing in for the article body.",
      article: { title: "Article Title" },
    };
    const result = parsePost(tweet, "exampleauthor");
    expect(result.contentType).toBe("article");
    expect(result.articleEnrichment).toBe("unavailable");
    expect(result.header).toBe("Article Title");
    expect(result.text).toBe(tweet.text);
  });

  it("falls back to a truncated-text header when no article title is present", () => {
    const tweet: RawTweet = {
      ...baseTweet,
      text: "A".repeat(120),
      article: {
        preview_text: `${"A".repeat(120)} plus a meaningfully longer body of enriched article content here.`,
      },
    };
    const result = parsePost(tweet, "exampleauthor");
    expect(result.header.endsWith("...")).toBe(true);
  });
});
