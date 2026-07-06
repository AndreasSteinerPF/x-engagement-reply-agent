import type { RawIncludes, RawTweet, RawUser } from "./types";

const X_API_BASE_URL = "https://api.twitter.com/2";

// Matches the reference implementation's own field/expansion lists
// (investors-mcp app/api/automation/monitor-x/route.ts) minus the
// conversation_id/entities fields this agent doesn't use yet.
const TWEET_FIELDS =
  "article,author_id,created_at,in_reply_to_user_id,note_tweet,referenced_tweets,text";
const TWEET_EXPANSIONS = "author_id,referenced_tweets.id,referenced_tweets.id.author_id";
const USER_FIELDS = "id,name,username";
const MAX_IDS_PER_REQUEST = 100;

export type RateLimitInfo = {
  remaining: number;
  resetEpochSeconds: number;
};

export class XRateLimitError extends Error {
  readonly rateLimit: RateLimitInfo;

  constructor(rateLimit: RateLimitInfo) {
    super("X API rate limit exceeded");
    this.name = "XRateLimitError";
    this.rateLimit = rateLimit;
  }
}

export type XClientOptions = {
  bearerToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export type FetchRecentPostsOptions = {
  sinceId?: string;
  maxResults?: number;
};

export type XClient = {
  resolveUserIds: (handles: string[]) => Promise<Map<string, RawUser>>;
  fetchRecentPosts: (
    userId: string,
    options?: FetchRecentPostsOptions,
  ) => Promise<{ posts: RawTweet[]; includes: RawIncludes }>;
  fetchPostsByIds: (ids: string[]) => Promise<{ posts: RawTweet[]; includes: RawIncludes }>;
};

export function createXClient(options: XClientOptions): XClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? X_API_BASE_URL;

  async function request<T>(path: string, searchParams: Record<string, string>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${options.bearerToken}` },
    });

    if (response.status === 429) {
      throw new XRateLimitError({
        remaining: Number.parseInt(response.headers.get("x-rate-limit-remaining") ?? "0", 10),
        resetEpochSeconds: Number.parseInt(response.headers.get("x-rate-limit-reset") ?? "0", 10),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `X API request failed: HTTP ${response.status} ${path} ${body.slice(0, 500)}`,
      );
    }

    return (await response.json()) as T;
  }

  async function resolveUserIds(handles: string[]): Promise<Map<string, RawUser>> {
    const usersByHandle = new Map<string, RawUser>();
    for (const group of chunk(handles, MAX_IDS_PER_REQUEST)) {
      const data = await request<{ data?: RawUser[] }>("/users/by", {
        usernames: group.join(","),
        "user.fields": USER_FIELDS,
      });
      for (const user of data.data ?? []) {
        usersByHandle.set(user.username.toLowerCase(), user);
      }
    }
    return usersByHandle;
  }

  async function fetchRecentPosts(
    userId: string,
    fetchOptions: FetchRecentPostsOptions = {},
  ): Promise<{ posts: RawTweet[]; includes: RawIncludes }> {
    const searchParams: Record<string, string> = {
      "tweet.fields": TWEET_FIELDS,
      expansions: TWEET_EXPANSIONS,
      "user.fields": USER_FIELDS,
      max_results: String(fetchOptions.maxResults ?? 20),
    };
    if (fetchOptions.sinceId) {
      searchParams.since_id = fetchOptions.sinceId;
    }

    const data = await request<{ data?: RawTweet[]; includes?: RawIncludes }>(
      `/users/${userId}/tweets`,
      searchParams,
    );
    return { posts: data.data ?? [], includes: data.includes ?? {} };
  }

  async function fetchPostsByIds(
    ids: string[],
  ): Promise<{ posts: RawTweet[]; includes: RawIncludes }> {
    const posts: RawTweet[] = [];
    const users: RawUser[] = [];
    for (const group of chunk(ids, MAX_IDS_PER_REQUEST)) {
      const data = await request<{ data?: RawTweet[]; includes?: RawIncludes }>("/tweets", {
        ids: group.join(","),
        "tweet.fields": TWEET_FIELDS,
        expansions: TWEET_EXPANSIONS,
        "user.fields": USER_FIELDS,
      });
      posts.push(...(data.data ?? []));
      users.push(...(data.includes?.users ?? []));
    }
    return { posts, includes: { users } };
  }

  return { resolveUserIds, fetchRecentPosts, fetchPostsByIds };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
