import type { RawTweet } from "./types";

export type ArticleEnrichmentStatus = "not-applicable" | "available" | "unavailable";

export type ParsedPost = {
  statusId: string;
  sourceUri: string;
  authorId: string;
  authorHandle: string;
  header: string;
  text: string;
  contentType: "post" | "article";
  articleEnrichment: ArticleEnrichmentStatus;
  createdAt: string;
};

// Minimum extra length the reference implementation (buildTextFromXApiTweet)
// requires before treating enriched article/note content as a real
// improvement over the plain tweet text, rather than noise/duplication.
const MEANINGFUL_ENRICHMENT_MARGIN = 40;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Ported near-verbatim from investors-mcp's truncateToHeader.
 */
export function truncateToHeader(text: string, maxLength = 80): string {
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    return `${truncated.slice(0, lastSpace)}...`;
  }
  return `${truncated}...`;
}

/**
 * Parses a raw X API v2 tweet into this agent's post domain shape.
 *
 * Deliberately does NOT port the reference implementation's GraphQL
 * scraping / bearer-token-discovery fallback chain for full X "Article"
 * bodies (undocumented-API territory, ToS risk, disproportionate for this
 * milestone -- see docs/implementation-plan.md). Only documented v2 fields
 * (`article`, `note_tweet`) are used; when they don't yield meaningfully
 * more content than the plain tweet text, articleEnrichment is explicitly
 * "unavailable" rather than silently falling back without a trace.
 */
export function parsePost(tweet: RawTweet, authorHandle: string): ParsedPost {
  const sourceUri = `https://x.com/${authorHandle}/status/${tweet.id}`;
  const fallbackText = normalizeWhitespace(tweet.text ?? "");
  const enrichment = enrichContent(tweet, fallbackText);

  return {
    statusId: tweet.id,
    sourceUri,
    authorId: tweet.author_id ?? "",
    authorHandle,
    header: enrichment.header,
    text: enrichment.text,
    contentType: enrichment.contentType,
    articleEnrichment: enrichment.articleEnrichment,
    createdAt: tweet.created_at ?? "",
  };
}

function enrichContent(
  tweet: RawTweet,
  fallbackText: string,
): {
  header: string;
  text: string;
  contentType: "post" | "article";
  articleEnrichment: ArticleEnrichmentStatus;
} {
  if (tweet.article) {
    const title = normalizeWhitespace(tweet.article.title ?? "");
    const body = normalizeWhitespace(
      tweet.article.preview_text ?? tweet.article.text ?? tweet.article.content ?? "",
    );
    const hasMeaningfulBody = body.length > fallbackText.length + MEANINGFUL_ENRICHMENT_MARGIN;
    const text = hasMeaningfulBody ? body : fallbackText;
    return {
      header: title || truncateToHeader(text),
      text,
      contentType: "article",
      articleEnrichment: hasMeaningfulBody ? "available" : "unavailable",
    };
  }

  const noteText = normalizeWhitespace(tweet.note_tweet?.text ?? "");
  if (noteText.length > fallbackText.length) {
    return {
      header: truncateToHeader(noteText),
      text: noteText,
      contentType: "post",
      articleEnrichment: "not-applicable",
    };
  }

  return {
    header: truncateToHeader(fallbackText),
    text: fallbackText,
    contentType: "post",
    articleEnrichment: "not-applicable",
  };
}
