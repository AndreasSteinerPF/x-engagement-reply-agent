export type RawUser = {
  id: string;
  username: string;
  name: string;
};

export type ReferencedTweetType = "replied_to" | "quoted" | "retweeted";

export type ReferencedTweetRef = {
  type: ReferencedTweetType;
  id: string;
};

export type RawArticle = {
  title?: string;
  preview_text?: string;
  text?: string;
  content?: string;
};

export type RawNoteTweet = {
  text?: string;
};

export type RawTweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: ReferencedTweetRef[];
  note_tweet?: RawNoteTweet;
  article?: RawArticle;
};

export type RawIncludes = {
  users?: RawUser[];
  tweets?: RawTweet[];
};
