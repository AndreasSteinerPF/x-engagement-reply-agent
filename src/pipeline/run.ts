import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunSummarySchema, type RunSummary } from "@agent-network/contract";
import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../obs/logger.js";
import type { AnyTraceSink } from "../obs/trace.js";
import {
  normalizeAuthor,
  postKey,
  type ArticleMatcher,
  type ArticleRecommendation,
  type AsanaClient,
  type AsanaParentResult,
  type AsanaSubtaskResult,
  type MatchedArticle,
  type MonitorState,
  type ReplyGenerator,
  type StateStore,
  type WatchAuthor,
  type XClient,
  type XPost,
} from "../ports.js";
import { compareStatusIds } from "../adapters/x/fixture.js";
import { isExcludedAuthor, meetsTaskThreshold, recommendedArticles } from "./thresholds.js";

export interface RunDeps {
  config: AgentConfig;
  xClient: XClient;
  matcher: ArticleMatcher;
  generator: ReplyGenerator;
  asana: AsanaClient;
  state: StateStore;
  trace: AnyTraceSink;
  logger: Logger;
  outDir: string;
  modes: { x: string; llm: string; asana: string };
}

export interface RunOptions {
  runId: string;
  dryRun: boolean;
  /** Restrict the run to a single author (handle or display name). */
  authorFilter?: string;
  /** Bypass the `paused` setting. */
  force?: boolean;
  batchSize?: number;
  maxPostsPerAuthor?: number;
  topK?: number;
  /** The agent id used in the run summary (defaults to the manifest id). */
  agentId?: string;
}

/** Detailed per-post record captured in the full run artifact. */
export interface ProcessedPostRecord {
  post: XPost;
  isReferenced: boolean;
  outcome: "tasked" | "skipped" | "failed";
  reason?: string;
  matches: MatchedArticle[];
  recommendations: ArticleRecommendation[];
  parent?: AsanaParentResult;
  subtasks?: AsanaSubtaskResult;
}

export interface RunArtifact {
  runId: string;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  modes: RunDeps["modes"];
  authorsPolled: string[];
  posts: ProcessedPostRecord[];
}

export interface RunResult {
  summary: RunSummary;
  artifact: RunArtifact;
}

/**
 * Run one polling pass: select an author batch, detect new posts, enrich
 * referenced originals, match each post against the Soofi corpus, gate on
 * thresholds, draft prompt-driven replies, create Asana approval tasks, and
 * persist cursors + dedupe state. Returns a structured run summary + a detailed
 * artifact. In dry-run, no Asana tasks are created and no state is persisted.
 */
export async function runMonitor(deps: RunDeps, opts: RunOptions): Promise<RunResult> {
  const { config, logger } = deps;
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const agentId = opts.agentId ?? "kestrel";

  const metrics = initMetrics();
  const reasons: Record<string, number> = {};
  const posts: ProcessedPostRecord[] = [];
  const authorsPolled: string[] = [];
  const tallyReason = (reason: string) => (reasons[reason] = (reasons[reason] ?? 0) + 1);

  if (config.settings.paused && !opts.force) {
    logger.warn("pipeline paused — skipping (use --force to override)");
    return finalize(deps, opts, { metrics, reasons, posts, authorsPolled, startedAt, startMs, agentId, status: "skipped" });
  }

  const state = await deps.state.loadState();
  const batch = pickAuthorBatch(config.watchlist, state, opts);
  const topK = opts.topK ?? config.settings.defaultTopK;
  const maxPosts = opts.maxPostsPerAuthor ?? config.settings.defaultMaxPostsPerAuthor;

  logger.info("run started", {
    runId: opts.runId,
    dryRun: opts.dryRun,
    authors: batch.map((a) => a.handle),
    modes: deps.modes,
  });

  for (const author of batch) {
    authorsPolled.push(author.handle);
    metrics.authorsPolled += 1;

    let fetched: XPost[];
    try {
      fetched = await deps.xClient.fetchLatestPosts(author, maxPosts);
    } catch (err) {
      logger.error("fetch failed", { handle: author.handle, error: (err as Error).message });
      tallyReason("fetch-failed");
      continue;
    }
    metrics.postsFetched += fetched.length;

    const lastSeen = state.lastSeenStatusIdByHandle[author.handle];
    const newPosts = fetched.filter((p) => !lastSeen || compareStatusIds(p.statusId, lastSeen) > 0);
    logger.info("polled author", { handle: author.handle, fetched: fetched.length, new: newPosts.length });

    // Advance the cursor for this handle to the newest fetched id.
    if (fetched.length > 0) {
      const newest = fetched.reduce((m, p) => (compareStatusIds(p.statusId, m) > 0 ? p.statusId : m), fetched[0]!.statusId);
      if (!lastSeen || compareStatusIds(newest, lastSeen) > 0) state.lastSeenStatusIdByHandle[author.handle] = newest;
    }

    // Build the work list: each new post plus its referenced originals.
    for (const post of newPosts) {
      const work = await expandReferencedPosts(post, author, deps);
      metrics.referencedPostsFetched += work.filter((w) => w.isReferenced).length;

      for (const item of work) {
        const record = await processPost(deps, opts, state, metrics, tallyReason, item.post, item.watch, item.isReferenced);
        posts.push(record);
      }
    }
  }

  // Advance the round-robin cursor for the next run.
  state.cursor = (state.cursor + batch.length) % Math.max(1, getActiveAuthors(config.watchlist).length);

  if (!opts.dryRun) {
    await deps.state.saveState(state);
  }

  const status: RunSummary["status"] = metrics.failed > 0 ? "partial" : "success";
  return finalize(deps, opts, { metrics, reasons, posts, authorsPolled, startedAt, startMs, agentId, status });
}

/** Build the work list for a post: the post itself plus any referenced originals. */
async function expandReferencedPosts(
  post: XPost,
  watch: WatchAuthor,
  deps: RunDeps,
): Promise<Array<{ post: XPost; isReferenced: boolean; watch: WatchAuthor }>> {
  const work: Array<{ post: XPost; isReferenced: boolean; watch: WatchAuthor }> = [{ post, isReferenced: false, watch }];
  try {
    const refs = await deps.xClient.fetchReferencedPosts(post);
    for (const ref of refs) {
      work.push({ post: ref, isReferenced: true, watch });
    }
  } catch (err) {
    deps.logger.warn("referenced fetch failed", { statusId: post.statusId, error: (err as Error).message });
  }
  return work;
}

async function processPost(
  deps: RunDeps,
  opts: RunOptions,
  state: MonitorState,
  metrics: MetricCounters,
  tallyReason: (reason: string) => void,
  post: XPost,
  watch: WatchAuthor,
  isReferenced: boolean,
): Promise<ProcessedPostRecord> {
  const { config, logger } = deps;
  const authorNormalized = normalizeAuthor(post.handle || post.author);
  const key = postKey(authorNormalized, post.statusId);
  const base: ProcessedPostRecord = { post, isReferenced, outcome: "skipped", matches: [], recommendations: [] };

  // Dedupe: already processed in a prior run.
  if (state.processedKeys.includes(key)) {
    base.reason = "already-processed";
    tallyReason("already-processed");
    metrics.skipped += 1;
    logger.debug("skip already-processed", { statusId: post.statusId });
    return base;
  }
  metrics.newPostsProcessed += 1;

  // Article matching (real, via the hosted MCP).
  let matches: MatchedArticle[];
  try {
    matches = await deps.matcher.getTopSoofiArticleSimilarities(buildCorpusQuery(post), opts.topK ?? config.settings.defaultTopK);
  } catch (err) {
    base.outcome = "failed";
    base.reason = `match-failed: ${(err as Error).message}`;
    tallyReason("match-failed");
    metrics.failed += 1;
    logger.error("similarity match failed", { statusId: post.statusId, error: (err as Error).message });
    await recordProcessedPost(deps, opts, state, key, post, authorNormalized, "failed", base.reason);
    return base;
  }
  base.matches = matches;
  metrics.articlesMatched += matches.length;

  const bestRaw = matches[0]?.rawScore ?? 0;
  const bestScore100 = matches[0]?.score100 ?? 0;

  // Exclusion: never task the corpus author's own posts.
  if (isExcludedAuthor(post.handle || post.author, config.settings.excludeAuthors)) {
    base.reason = "excluded-author";
    tallyReason("excluded-author");
    metrics.skipped += 1;
    logger.info("skip excluded author", { handle: post.handle, statusId: post.statusId });
    await recordProcessedPost(deps, opts, state, key, post, authorNormalized, "skipped", base.reason);
    return base;
  }

  // Parent task gate (best-match raw similarity).
  if (!meetsTaskThreshold(bestRaw, config.settings.asanaTaskSimilarityThreshold)) {
    base.reason = `below-task-threshold:${bestRaw.toFixed(4)}<${config.settings.asanaTaskSimilarityThreshold}`;
    tallyReason("below-task-threshold");
    metrics.skipped += 1;
    logger.info("skip below task threshold", { statusId: post.statusId, bestRaw });
    await recordProcessedPost(deps, opts, state, key, post, authorNormalized, "skipped", base.reason);
    return base;
  }

  // Article recommendation gate -> generate replies for qualifying articles.
  const qualifying = recommendedArticles(matches, config.settings.articleSimilarityThreshold);
  const recommendations: ArticleRecommendation[] = [];
  for (const article of qualifying) {
    const gen = await deps.generator.generate({
      post,
      article,
      systemPrompt: config.systemPrompt,
      responseConstraints: config.responseConstraints,
      prompts: config.replyPrompts.map((p) => ({ index: p.index, label: p.label, text: p.text, requireQuestion: p.requireQuestion })),
    });
    metrics.repliesGenerated += gen.responses.length;
    await deps.trace.write({ ...gen.trace, postStatusId: post.statusId, articleSourceUri: article.sourceUri });
    logger.info("drafted replies", {
      statusId: post.statusId,
      article: article.title.slice(0, 50),
      provider: gen.trace.provider,
      replies: gen.responses.length,
    });
    recommendations.push({ ...article, whyRecommended: gen.whyRecommended, suggestedResponses: gen.responses });
  }
  base.recommendations = recommendations;

  const thresholdMet = recommendations.length > 0;

  // Asana parent task.
  const parent = await deps.asana.createParentTask({
    watch,
    post,
    recommendations,
    topRawScore: bestRaw,
    topScore100: bestScore100,
    thresholdMet,
    dryRun: opts.dryRun,
  });
  base.parent = parent;
  if (parent.created) metrics.asanaParentTasksCreated += 1;

  // Asana approval subtasks (one per article x prompt).
  if (recommendations.length > 0 && (parent.created || opts.dryRun)) {
    const subtasks = await deps.asana.createRecommendationSubtasks({
      parentTaskGid: parent.gid ?? `pending-${post.statusId}`,
      watch,
      post,
      recommendations,
      dryRun: opts.dryRun,
    });
    base.subtasks = subtasks;
    metrics.asanaSubtasksCreated += subtasks.created;
  }

  base.outcome = parent.created ? "tasked" : "skipped";
  if (!parent.created && parent.reason) base.reason = parent.reason;
  if (parent.created) metrics.tasked += 1;
  await recordProcessedPost(deps, opts, state, key, post, authorNormalized, base.outcome === "tasked" ? "tasked" : "skipped", base.reason);
  return base;
}

/** The text used to query the corpus — prefer enriched long-form article text. */
function buildCorpusQuery(post: XPost): string {
  return (post.articleText && post.articleText.length > post.text.length ? post.articleText : post.text).trim();
}

async function recordProcessedPost(
  deps: RunDeps,
  opts: RunOptions,
  state: MonitorState,
  key: string,
  post: XPost,
  authorNormalized: string,
  outcome: "tasked" | "skipped" | "failed" | "ingested",
  reason?: string,
): Promise<void> {
  state.processedKeys.push(key);
  if (opts.dryRun) return; // dry-run leaves state untouched for repeatability
  await deps.state.recordPost({
    authorNormalized,
    statusId: post.statusId,
    sourceUri: post.sourceUri,
    outcome,
    reason,
    at: new Date().toISOString(),
  });
}

interface MetricCounters {
  authorsPolled: number;
  postsFetched: number;
  newPostsProcessed: number;
  referencedPostsFetched: number;
  articlesMatched: number;
  repliesGenerated: number;
  asanaParentTasksCreated: number;
  asanaSubtasksCreated: number;
  ingested: number;
  skipped: number;
  failed: number;
  tasked: number;
}

function initMetrics(): MetricCounters {
  return {
    authorsPolled: 0,
    postsFetched: 0,
    newPostsProcessed: 0,
    referencedPostsFetched: 0,
    articlesMatched: 0,
    repliesGenerated: 0,
    asanaParentTasksCreated: 0,
    asanaSubtasksCreated: 0,
    ingested: 0,
    skipped: 0,
    failed: 0,
    tasked: 0,
  };
}

function getActiveAuthors(watchlist: WatchAuthor[]): WatchAuthor[] {
  return watchlist.filter((a) => a.active);
}

/** Select the author batch via cursor rotation, or a single author when filtered. */
export function pickAuthorBatch(watchlist: WatchAuthor[], state: MonitorState, opts: RunOptions): WatchAuthor[] {
  const active = getActiveAuthors(watchlist);
  if (opts.authorFilter) {
    const f = normalizeAuthor(opts.authorFilter);
    return active.filter((a) => normalizeAuthor(a.handle) === f || normalizeAuthor(a.author) === f);
  }
  if (active.length === 0) return [];
  const size = Math.min(opts.batchSize ?? active.length, active.length);
  const start = state.cursor % active.length;
  const rotated = [...active.slice(start), ...active.slice(0, start)];
  return rotated.slice(0, size);
}

async function finalize(
  deps: RunDeps,
  opts: RunOptions,
  ctx: {
    metrics: MetricCounters;
    reasons: Record<string, number>;
    posts: ProcessedPostRecord[];
    authorsPolled: string[];
    startedAt: string;
    startMs: number;
    agentId: string;
    status: RunSummary["status"];
  },
): Promise<RunResult> {
  const finishedAt = new Date().toISOString();
  const durationMs = Math.round(performance.now() - ctx.startMs);
  const { tasked, ...metrics } = ctx.metrics;
  void tasked;

  const summary: RunSummary = RunSummarySchema.parse({
    agentId: ctx.agentId,
    runId: opts.runId,
    startedAt: ctx.startedAt,
    finishedAt,
    durationMs,
    dryRun: opts.dryRun,
    status: ctx.status,
    metrics,
    reasons: ctx.reasons,
    notes: `x=${deps.modes.x} llm=${deps.modes.llm} asana=${deps.modes.asana}`,
  });

  const artifact: RunArtifact = {
    runId: opts.runId,
    agentId: ctx.agentId,
    startedAt: ctx.startedAt,
    finishedAt,
    dryRun: opts.dryRun,
    modes: deps.modes,
    authorsPolled: ctx.authorsPolled,
    posts: ctx.posts,
  };

  // Observability artifacts (written in both modes — this is the agent observing
  // itself, not an external side effect).
  const runsDir = join(deps.outDir, "runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${opts.runId}.summary.json`), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(join(runsDir, `${opts.runId}.full.json`), JSON.stringify(artifact, null, 2), "utf8");

  deps.logger.info("run complete", {
    runId: opts.runId,
    status: summary.status,
    durationMs,
    ...summary.metrics,
  });

  return { summary, artifact };
}
