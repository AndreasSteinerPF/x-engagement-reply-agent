import type { WatchAuthor, XClient, XPost } from "../../ports.js";

/**
 * Live {@link XClient} backed by the X API v2. This is the production swap for
 * {@link FixtureXClient}; it activates when `X_BEARER_TOKEN` is set.
 *
 * NOTE: this path requires X API credentials, which were not provided for this
 * milestone, so it is shipped as a faithful, reviewable implementation rather
 * than an exercised one. The reference pipeline additionally falls back to HTML
 * scraping (TWStalker) and Jina markdown when the API is unavailable; those
 * fallbacks are intentionally out of scope here (documented in docs/decisions.md
 * ADR-0005). The agent selects this client only when a token is present.
 */
export class LiveXClient implements XClient {
  private readonly origin: string;
  private readonly bearer: string;
  private readonly userIdCache = new Map<string, string>();
  private readonly referencesByStatusId = new Map<string, XPost[]>();

  constructor(opts: { bearerToken: string; apiOrigin?: string }) {
    this.bearer = opts.bearerToken;
    this.origin = opts.apiOrigin ?? process.env.X_MONITOR_X_API_ORIGIN ?? "https://api.twitter.com";
  }

  async fetchLatestPosts(author: WatchAuthor, max: number): Promise<XPost[]> {
    const userId = await this.resolveUserId(author.handle);
    const url = new URL(`${this.origin}/2/users/${userId}/tweets`);
    url.searchParams.set("max_results", String(Math.min(Math.max(max, 5), 100)));
    url.searchParams.set("exclude", "retweets");
    url.searchParams.set("tweet.fields", "created_at,referenced_tweets,note_tweet,author_id");
    url.searchParams.set("expansions", "referenced_tweets.id,author_id");
    url.searchParams.set("user.fields", "name,username");

    const body = await this.get<XTimelineResponse>(url.toString());
    const userById = indexUsers(body.includes?.users);
    const referencedById = indexTweets(body.includes?.tweets);

    const posts: XPost[] = [];
    for (const t of body.data ?? []) {
      const post = this.toPost(t, author, userById);
      const refs = (t.referenced_tweets ?? [])
        .map((r) => referencedById.get(r.id))
        .filter((x): x is XTweet => Boolean(x))
        .map((rt) => this.toPost(rt, undefined, userById, post.statusId));
      if (refs.length) this.referencesByStatusId.set(post.statusId, refs);
      posts.push(post);
    }
    return posts;
  }

  async fetchReferencedPosts(post: XPost): Promise<XPost[]> {
    return this.referencesByStatusId.get(post.statusId) ?? [];
  }

  private async resolveUserId(handle: string): Promise<string> {
    const clean = handle.replace(/^@/, "");
    const cached = this.userIdCache.get(clean);
    if (cached) return cached;
    const body = await this.get<{ data?: { id: string } }>(`${this.origin}/2/users/by/username/${clean}`);
    const id = body.data?.id;
    if (!id) throw new Error(`X API: could not resolve user id for @${clean}`);
    this.userIdCache.set(clean, id);
    return id;
  }

  private toPost(
    t: XTweet,
    author: WatchAuthor | undefined,
    users: Map<string, XUser>,
    referencedByStatusId?: string,
  ): XPost {
    const user = t.author_id ? users.get(t.author_id) : undefined;
    const handle = (author?.handle ?? user?.username ?? "unknown").replace(/^@/, "");
    const text = t.note_tweet?.text ?? t.text;
    return {
      statusId: t.id,
      sourceUri: `https://x.com/${handle}/status/${t.id}`,
      handle,
      author: author?.author ?? user?.name ?? handle,
      header: text.split(/(?<=[.!?])\s/)[0]?.slice(0, 80) ?? text.slice(0, 80),
      text,
      kind: referenceKind(t),
      createdAt: t.created_at,
      articleText: t.note_tweet?.text,
      referencedByStatusId,
    };
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.bearer}` } });
    if (!res.ok) throw new Error(`X API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

interface XUser {
  id: string;
  name: string;
  username: string;
}
interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
  note_tweet?: { text: string };
}
interface XTimelineResponse {
  data?: XTweet[];
  includes?: { tweets?: XTweet[]; users?: XUser[] };
}

function referenceKind(t: XTweet): XPost["kind"] {
  const type = t.referenced_tweets?.[0]?.type;
  if (type === "replied_to") return "reply";
  if (type === "quoted") return "quote";
  return "post";
}

function indexUsers(users?: XUser[]): Map<string, XUser> {
  return new Map((users ?? []).map((u) => [u.id, u]));
}
function indexTweets(tweets?: XTweet[]): Map<string, XTweet> {
  return new Map((tweets ?? []).map((t) => [t.id, t]));
}
