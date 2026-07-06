import type { RawTweet, RawUser, ReferencedTweetType } from "./types";

export type InteractionType = "original" | "reply" | "quote" | "repost";

export type InteractionResult = {
  type: InteractionType;
  referencedStatusId?: string;
  referencedAuthorId?: string;
  referencedAuthorHandle?: string;
};

export type InteractionLookups = {
  usersById: Map<string, RawUser>;
  tweetsById: Map<string, RawTweet>;
};

const REFERENCED_TYPE_TO_INTERACTION: Record<ReferencedTweetType, InteractionType> = {
  replied_to: "reply",
  quoted: "quote",
  retweeted: "repost",
};

// https://x.com/<handle>/status/<id> or the legacy twitter.com host.
const STATUS_LINK_PATTERN = /https?:\/\/(?:twitter\.com|x\.com)\/[^/\s]+\/status\/(\d+)/i;
const LEADING_MENTION_PATTERN = /^@(\w{1,15})\b/;

/**
 * Classifies whether a post is a reply, quote, repost, or an original post,
 * preferring the API's own referenced_tweets metadata and falling back to a
 * lightweight text heuristic only when that metadata is entirely absent
 * (per the assignment's acceptance criteria -- most posts fetched with the
 * referenced_tweets expansion will have authoritative metadata, so the
 * heuristic is a defensive edge case, not the primary path).
 */
export function classifyInteraction(
  tweet: RawTweet,
  lookups: InteractionLookups,
): InteractionResult {
  const referenced = tweet.referenced_tweets?.[0];
  if (referenced) {
    const type = REFERENCED_TYPE_TO_INTERACTION[referenced.type];
    const referencedAuthorId = resolveReferencedAuthorId(
      tweet,
      referenced.id,
      referenced.type,
      lookups,
    );
    const referencedAuthorHandle = referencedAuthorId
      ? lookups.usersById.get(referencedAuthorId)?.username
      : undefined;

    return {
      type,
      referencedStatusId: referenced.id,
      referencedAuthorId,
      referencedAuthorHandle,
    };
  }

  return classifyByTextHeuristic(tweet.text ?? "") ?? { type: "original" };
}

function resolveReferencedAuthorId(
  tweet: RawTweet,
  referencedStatusId: string,
  referencedType: ReferencedTweetType,
  lookups: InteractionLookups,
): string | undefined {
  if (referencedType === "replied_to" && tweet.in_reply_to_user_id) {
    return tweet.in_reply_to_user_id;
  }
  return lookups.tweetsById.get(referencedStatusId)?.author_id;
}

function classifyByTextHeuristic(text: string): InteractionResult | null {
  const linkMatch = STATUS_LINK_PATTERN.exec(text);
  if (linkMatch) {
    return { type: "quote", referencedStatusId: linkMatch[1] };
  }
  if (LEADING_MENTION_PATTERN.test(text)) {
    return { type: "reply" };
  }
  return null;
}
