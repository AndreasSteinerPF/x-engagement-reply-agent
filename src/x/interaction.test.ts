import { describe, expect, it } from "vitest";
import { classifyInteraction } from "./interaction";
import type { RawTweet, RawUser } from "./types";

function lookups(users: RawUser[] = [], tweets: RawTweet[] = []) {
  return {
    usersById: new Map(users.map((u) => [u.id, u])),
    tweetsById: new Map(tweets.map((t) => [t.id, t])),
  };
}

describe("classifyInteraction", () => {
  it("classifies an original post with no referenced_tweets and no heuristic match", () => {
    const tweet: RawTweet = { id: "1", text: "Just a regular post." };
    const result = classifyInteraction(tweet, lookups());
    expect(result).toEqual({ type: "original" });
  });

  it("classifies a reply using referenced_tweets + in_reply_to_user_id", () => {
    const tweet: RawTweet = {
      id: "2",
      text: "@originalauthor good point",
      in_reply_to_user_id: "99",
      referenced_tweets: [{ type: "replied_to", id: "1" }],
    };
    const result = classifyInteraction(
      tweet,
      lookups([{ id: "99", username: "originalauthor", name: "Original" }]),
    );

    expect(result.type).toBe("reply");
    expect(result.referencedStatusId).toBe("1");
    expect(result.referencedAuthorId).toBe("99");
    expect(result.referencedAuthorHandle).toBe("originalauthor");
  });

  it("classifies a quote and resolves the referenced author via the included tweet", () => {
    const tweet: RawTweet = {
      id: "3",
      text: "Quoting this take",
      referenced_tweets: [{ type: "quoted", id: "1" }],
    };
    const referencedTweet: RawTweet = { id: "1", text: "original", author_id: "77" };

    const result = classifyInteraction(
      tweet,
      lookups([{ id: "77", username: "quotedauthor", name: "Quoted" }], [referencedTweet]),
    );

    expect(result.type).toBe("quote");
    expect(result.referencedStatusId).toBe("1");
    expect(result.referencedAuthorId).toBe("77");
    expect(result.referencedAuthorHandle).toBe("quotedauthor");
  });

  it("classifies a repost (retweet)", () => {
    const tweet: RawTweet = {
      id: "4",
      text: "RT @someone: original content",
      referenced_tweets: [{ type: "retweeted", id: "1" }],
    };
    const result = classifyInteraction(tweet, lookups());
    expect(result.type).toBe("repost");
    expect(result.referencedStatusId).toBe("1");
  });

  it("leaves referencedAuthorHandle undefined when the author cannot be resolved", () => {
    const tweet: RawTweet = {
      id: "5",
      text: "Quoting an untracked author",
      referenced_tweets: [{ type: "quoted", id: "unknown-status" }],
    };
    const result = classifyInteraction(tweet, lookups());
    expect(result.referencedAuthorId).toBeUndefined();
    expect(result.referencedAuthorHandle).toBeUndefined();
  });

  describe("text-heuristic fallback (only when referenced_tweets is absent)", () => {
    it("detects a quote-like status link in the text", () => {
      const tweet: RawTweet = {
        id: "6",
        text: "Check this out https://x.com/someone/status/9876543210",
      };
      const result = classifyInteraction(tweet, lookups());
      expect(result).toEqual({ type: "quote", referencedStatusId: "9876543210" });
    });

    it("detects a legacy twitter.com status link", () => {
      const tweet: RawTweet = {
        id: "7",
        text: "See https://twitter.com/someone/status/123",
      };
      const result = classifyInteraction(tweet, lookups());
      expect(result.type).toBe("quote");
      expect(result.referencedStatusId).toBe("123");
    });

    it("detects a leading-mention reply pattern", () => {
      const tweet: RawTweet = { id: "8", text: "@someone I think you're right about this." };
      const result = classifyInteraction(tweet, lookups());
      expect(result).toEqual({ type: "reply" });
    });

    it("does not apply the heuristic when referenced_tweets metadata is present", () => {
      const tweet: RawTweet = {
        id: "9",
        text: "@someone this text looks reply-like but metadata says otherwise",
        referenced_tweets: [{ type: "quoted", id: "1" }],
      };
      const result = classifyInteraction(tweet, lookups());
      expect(result.type).toBe("quote");
    });
  });
});
