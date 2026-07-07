/**
 * Shared test helpers: builders for AgentConfig, MatchedArticle, posts, and the
 * in-memory port fakes used by the pipeline tests.
 */
import { MonitorSettingsSchema, type AgentConfig, type ReplyPrompt } from "../src/config/schema.js";
import type {
  ArticleMatcher,
  MatchedArticle,
  ReplyGenerator,
  WatchAuthor,
  XClient,
  XPost,
} from "../src/ports.js";
import { DeterministicReplyGenerator } from "../src/adapters/llm/deterministic.js";

/** A realistic Soofi article excerpt with several quotable sentences. */
export const ARTICLE_EXCERPT =
  "On-chain property records make ownership verifiable end to end. " +
  "Today the title silo hides liens behind closed databases. " +
  "A public ledger turns every claim into something a buyer can independently check. " +
  "Incumbents profit from the opacity, so they will resist the change.";

export function makeArticle(overrides: Partial<MatchedArticle> = {}): MatchedArticle {
  return {
    sourceUri: "https://soofi.example/articles/on-chain-property",
    title: "Core Principle: Verifiable On-Chain Property Records",
    rawScore: 0.82,
    score100: 91,
    contextExcerpt: ARTICLE_EXCERPT,
    supportingParagraphs: [],
    ...overrides,
  };
}

export function makeWatchAuthor(overrides: Partial<WatchAuthor> = {}): WatchAuthor {
  return {
    author: "Balaji Srinivasan",
    handle: "balajis",
    company: "the-network-state",
    aliases: { handles: [], authors: ["Balaji"] },
    active: true,
    ...overrides,
  };
}

export function makePost(overrides: Partial<XPost> = {}): XPost {
  return {
    sourceUri: "https://x.com/balajis/status/1000",
    statusId: "1000",
    handle: "balajis",
    author: "Balaji Srinivasan",
    header: "On-chain property ownership",
    text: "We need verifiable on-chain property ownership records and liens.",
    kind: "post",
    ...overrides,
  };
}

/** Build a reply prompt slot. */
export function makePrompt(index: number, overrides: Partial<ReplyPrompt> = {}): ReplyPrompt {
  return {
    index,
    label: `Prompt ${index}`,
    text: `Recommend the article and draft a grounded reply (slot ${index}).`,
    requireQuestion: true,
    file: `${String(index).padStart(2, "0")}-prompt.md`,
    ...overrides,
  };
}

/** Parse the default settings (with optional overrides) into a MonitorSettings. */
export function makeSettings(overrides: Record<string, unknown> = {}) {
  return MonitorSettingsSchema.parse(overrides);
}

export interface ConfigOverrides {
  settings?: Record<string, unknown>;
  watchlist?: WatchAuthor[];
  replyPrompts?: ReplyPrompt[];
  responseConstraints?: string[];
  systemPrompt?: string;
}

/** Construct an AgentConfig directly (no files), suitable for the pipeline tests. */
export function makeConfig(o: ConfigOverrides = {}): AgentConfig {
  return {
    settings: makeSettings(o.settings),
    watchlist: o.watchlist ?? [makeWatchAuthor()],
    systemPrompt: o.systemPrompt ?? "You draft concise grounded replies for Soofi on X.",
    responseConstraints: o.responseConstraints ?? ["Maximum of 280 characters.", "Use short, simple sentences."],
    replyPrompts: o.replyPrompts ?? [makePrompt(1), makePrompt(2)],
    paths: {
      settings: "/virtual/config/settings.yaml",
      watchlist: "/virtual/config/watchlist.yaml",
      systemPrompt: "/virtual/prompts/system.md",
      constraints: "/virtual/prompts/constraints.md",
      replyPromptsDir: "/virtual/prompts/replies",
    },
  };
}

/**
 * In-memory ArticleMatcher: returns a controllable match list keyed by post text.
 * Falls back to `defaultMatches` for any unmapped text.
 */
export class FakeMatcher implements ArticleMatcher {
  calls: Array<{ postText: string; topK: number }> = [];
  constructor(
    private readonly byText: Map<string, MatchedArticle[]>,
    private readonly defaultMatches: MatchedArticle[] = [],
  ) {}
  async getTopSoofiArticleSimilarities(postText: string, topK: number): Promise<MatchedArticle[]> {
    this.calls.push({ postText, topK });
    const mapped = this.byText.get(postText.trim());
    const matches = mapped ?? this.defaultMatches;
    // Mirror real matcher contract: sorted descending by rawScore.
    return [...matches].sort((a, b) => b.rawScore - a.rawScore);
  }
}

/**
 * In-memory XClient: returns a controllable post list and referenced originals.
 */
export class FakeXClient implements XClient {
  constructor(
    private readonly posts: XPost[],
    private readonly referencedByStatusId: Map<string, XPost[]> = new Map(),
  ) {}
  async fetchLatestPosts(_author: WatchAuthor, max: number): Promise<XPost[]> {
    // newest first, like the real fixture client
    return [...this.posts].sort((a, b) => (a.statusId < b.statusId ? 1 : -1)).slice(0, max);
  }
  async fetchReferencedPosts(post: XPost): Promise<XPost[]> {
    return this.referencedByStatusId.get(post.statusId) ?? [];
  }
}

/** The real deterministic generator is offline + deterministic; reuse it as the pipeline generator. */
export function makeGenerator(): ReplyGenerator {
  return new DeterministicReplyGenerator();
}
