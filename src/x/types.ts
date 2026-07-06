import { z } from "zod";

// Schema-first (mirrors src/config/*.ts): every X API v2 response is
// validated against these schemas at the client boundary rather than
// blindly cast, per the company's "External System Response Validation"
// guideline -- an API silently changing shape or returning an error object
// with a 200 must fail loudly here, not corrupt data three modules away.

export const RawUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
});
export type RawUser = z.infer<typeof RawUserSchema>;

export const ReferencedTweetTypeSchema = z.enum(["replied_to", "quoted", "retweeted"]);
export type ReferencedTweetType = z.infer<typeof ReferencedTweetTypeSchema>;

export const ReferencedTweetRefSchema = z.object({
  type: ReferencedTweetTypeSchema,
  id: z.string(),
});
export type ReferencedTweetRef = z.infer<typeof ReferencedTweetRefSchema>;

export const RawArticleSchema = z.object({
  title: z.string().optional(),
  preview_text: z.string().optional(),
  text: z.string().optional(),
  content: z.string().optional(),
});
export type RawArticle = z.infer<typeof RawArticleSchema>;

export const RawNoteTweetSchema = z.object({
  text: z.string().optional(),
});
export type RawNoteTweet = z.infer<typeof RawNoteTweetSchema>;

export const RawTweetSchema = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  referenced_tweets: z.array(ReferencedTweetRefSchema).optional(),
  note_tweet: RawNoteTweetSchema.optional(),
  article: RawArticleSchema.optional(),
});
export type RawTweet = z.infer<typeof RawTweetSchema>;

export const RawIncludesSchema = z.object({
  users: z.array(RawUserSchema).optional(),
  tweets: z.array(RawTweetSchema).optional(),
});
export type RawIncludes = z.infer<typeof RawIncludesSchema>;

export const UsersByResponseSchema = z.object({
  data: z.array(RawUserSchema).optional(),
});

export const TweetsResponseSchema = z.object({
  data: z.array(RawTweetSchema).optional(),
  includes: RawIncludesSchema.optional(),
});
