/**
 * Domain types and ports (hexagonal boundaries) for the X Engagement Reply Agent.
 *
 * Everything the pipeline needs from the outside world is expressed as an
 * interface here. Concrete adapters (fixture/live X, offline/live Asana,
 * deterministic/LLM reply generation, file/Postgres state) implement these so
 * the pipeline runs identically with or without external credentials.
 */

/** A watched author, loaded from version-controlled `config/watchlist.yaml`. */
export interface WatchAuthor {
  author: string;
  handle: string;
  company: string;
  aliases: { handles: string[]; authors: string[] };
  active: boolean;
}

/** A post fetched from X (or a fixture). */
export interface XPost {
  /** Canonical URI, e.g. https://x.com/handle/status/123. */
  sourceUri: string;
  /** Numeric status id as a string (X ids exceed Number.MAX_SAFE_INTEGER). */
  statusId: string;
  /** Author handle without the @. */
  handle: string;
  /** Author display name. */
  author: string;
  /** Short human header used in task names. */
  header: string;
  /** Full post text — the query used for article matching. */
  text: string;
  /** ISO timestamp, if known. */
  createdAt?: string;
  /** Kind of engagement that produced this post. */
  kind?: "post" | "reply" | "quote";
  /** Long-form X article body, when enriched. */
  articleText?: string;
  /** For referenced originals: the status id of the watched post that referenced this. */
  referencedByStatusId?: string;
}

/** A Soofi article matched to a post via semantic similarity. */
export interface MatchedArticle {
  sourceUri: string;
  title: string;
  /** Raw cosine similarity in [0,1] as returned by the MCP (used for threshold gating). */
  rawScore: number;
  /** Display score in [1,100] = round(((rawScore + 1) / 2) * 100). */
  score100: number;
  /** Trimmed article content used to ground replies (<= ~1600 chars). */
  contextExcerpt: string;
  /** Up to 3 supporting paragraph passages (<= ~360 chars each). */
  supportingParagraphs: string[];
}

/** One drafted reply for a (matched article x reply prompt) pair. */
export interface SuggestedResponse {
  /** 1-based index of the prompt slot. */
  promptIndex: number;
  /** Human label, e.g. "Prompt 1". */
  promptLabel: string;
  /** The prompt instruction text the reply was generated from. */
  prompt: string;
  /** The drafted reply (<= 280 chars). */
  text: string;
}

/** A recommended article plus its drafted replies — the unit Asana subtasks are built from. */
export interface ArticleRecommendation extends MatchedArticle {
  /** Why this article was recommended (<= 35 words). */
  whyRecommended: string;
  suggestedResponses: SuggestedResponse[];
}

/** Source of posts (X API in production, fixtures locally). */
export interface XClient {
  /** Fetch up to `max` latest posts for a watched author, newest first. */
  fetchLatestPosts(author: WatchAuthor, max: number): Promise<XPost[]>;
  /** Fetch referenced originals (reply/quote targets) for a post, if any. */
  fetchReferencedPosts(post: XPost): Promise<XPost[]>;
}

/** Semantic article matching against the Soofi corpus (the hosted investors-mcp MCP). */
export interface ArticleMatcher {
  getTopSoofiArticleSimilarities(postText: string, topK: number): Promise<MatchedArticle[]>;
}

/** Input to a reply generator for one matched article. */
export interface ReplyGenerationInput {
  post: XPost;
  article: MatchedArticle;
  systemPrompt: string;
  responseConstraints: string[];
  /** The configured reply prompts (one per slot), in order. */
  prompts: Array<{ index: number; label: string; text: string; requireQuestion: boolean }>;
}

/** A reply generator's output for one matched article. */
export interface ReplyGenerationOutput {
  whyRecommended: string;
  responses: SuggestedResponse[];
  /** Trace record describing the generation run (for observability). */
  trace: ReplyGenerationTrace;
}

/** Observability record for one reply-generation run. */
export interface ReplyGenerationTrace {
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  promptCount: number;
  /** Approximate input/output sizes for cost visibility. */
  inputChars: number;
  outputChars: number;
  ok: boolean;
  error?: string;
}

/** Generates grounded reply drafts (deterministic offline, or a real LLM). */
export interface ReplyGenerator {
  readonly provider: string;
  readonly model: string;
  generate(input: ReplyGenerationInput): Promise<ReplyGenerationOutput>;
}

/** Result of creating an Asana parent task. */
export interface AsanaParentResult {
  created: boolean;
  gid?: string;
  permalinkUrl?: string;
  reason?: string;
}

/** Result of creating Asana subtasks. */
export interface AsanaSubtaskResult {
  created: number;
  gids: string[];
  reason?: string;
}

/** Asana task creation (offline sink in dev, real API in production). */
export interface AsanaClient {
  createParentTask(params: AsanaParentTaskParams): Promise<AsanaParentResult>;
  createRecommendationSubtasks(params: AsanaSubtaskParams): Promise<AsanaSubtaskResult>;
}

export interface AsanaParentTaskParams {
  watch: WatchAuthor;
  post: XPost;
  recommendations: ArticleRecommendation[];
  /** Best raw similarity across recommendations (for the custom field + gate). */
  topRawScore: number;
  topScore100: number;
  /** True when the article threshold was met (drives assignee + due date). */
  thresholdMet: boolean;
  dryRun: boolean;
}

export interface AsanaSubtaskParams {
  parentTaskGid: string;
  watch: WatchAuthor;
  post: XPost;
  recommendations: ArticleRecommendation[];
  dryRun: boolean;
}

/** Per-post processing outcome recorded in state. */
export type PostOutcome = "ingested" | "tasked" | "skipped" | "failed";

/** Persisted runtime state (cursors, dedupe, processed posts). */
export interface MonitorState {
  /** Round-robin cursor into the watchlist. */
  cursor: number;
  /** Highest-seen status id per handle. */
  lastSeenStatusIdByHandle: Record<string, string>;
  /** Dedupe keys for already-processed posts: `${authorNormalized}:${statusId}`. */
  processedKeys: string[];
}

/** External, durable state for the agent. */
export interface StateStore {
  loadState(): Promise<MonitorState>;
  saveState(state: MonitorState): Promise<void>;
  /** Record a per-post outcome (audit trail / dedupe detail). */
  recordPost(record: TrackedPost): Promise<void>;
}

export interface TrackedPost {
  authorNormalized: string;
  statusId: string;
  sourceUri: string;
  outcome: PostOutcome;
  reason?: string;
  at: string;
}

/** Normalize an author/handle to the corpus key form (lowercase, no spaces/@). */
export function normalizeAuthor(value: string): string {
  return value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");
}

/** Dedupe key for a processed post. */
export function postKey(authorNormalized: string, statusId: string): string {
  return `${authorNormalized}:${statusId}`;
}
