import type { ArticleOutcomePair } from "../asana/create-asana-tasking";
import type { WatchedAuthor } from "../config/watchlist";
import type { MonitorSettings } from "../config/settings";
import type { SideEffectGateway } from "../effects/side-effect-gateway";
import { generateDraftReplies } from "../agent/draft-replies";
import type { LangSmithFacade } from "../observability/langsmith";
import { getTopSoofiArticleSimilarities } from "../matching/get-top-article-similarities";
import { meetsArticleThreshold } from "../matching/similarity-gating";
import type { CircuitBreaker } from "../mcp/circuit-breaker";
import type { InvestorMcpClient } from "../mcp/investors-mcp-client";
import type { PromptSet } from "../prompts/load-prompts";
import { isNewerStatusId, type CursorStore } from "../state/cursor-store";
import type { DedupeStore } from "../state/dedupe-store";
import { classifyInteraction } from "../x/interaction";
import type { XClient } from "../x/client";
import { parsePost, type ParsedPost } from "../x/parse-post";
import type { LanguageModelV4 } from "@ai-sdk/provider";

export type RunMonitorDeps = {
  xClient: XClient;
  mcpClient: InvestorMcpClient;
  breaker: CircuitBreaker;
  model: LanguageModelV4;
  langsmith: LangSmithFacade;
  cursorStore: CursorStore;
  dedupeStore: DedupeStore;
  gateway: SideEffectGateway;
  settings: MonitorSettings;
  promptSet: PromptSet;
  watchlist: WatchedAuthor[];
  runKey: string;
};

export type PostOutcome = {
  sourceUri: string;
  statusId: string;
  authorHandle: string;
  outcome: "tasked" | "skipped" | "failed";
  skipReason?: string;
  asanaTaskGid?: string;
  asanaTaskUrl?: string;
  subtaskCount?: number;
};

export type RunSummary = {
  runKey: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  authorsPolled: number;
  postsFetched: number;
  newPostsProcessed: number;
  asanaTasksCreated: number;
  posts: PostOutcome[];
};

/**
 * The top-of-pipeline orchestrator: for every active watched author, fetch
 * new posts, classify them, match against Soofi's corpus, draft replies for
 * qualifying articles, and create the Asana task/subtasks -- wiring
 * together Phases 2-5 for the first time. Every dependency is injected so
 * this function is testable with fakes and reusable by both the real
 * Lambda handler and scripts/invoke-local.ts.
 *
 * Batch/cursor-rotation across the watchlist (per
 * docs/implementation-plan.md) is intentionally not implemented yet --
 * every active author is processed every run. At demo scale (a handful of
 * authors) this is a documented no-op simplification, not a missing
 * feature; add rotation state if the watchlist grows large enough for a
 * single run to no longer cover everyone.
 */
export async function runMonitor(deps: RunMonitorDeps): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const posts: PostOutcome[] = [];
  let postsFetched = 0;
  let asanaTasksCreated = 0;

  const activeAuthors = deps.watchlist.filter((author) => author.active);

  for (const author of activeAuthors) {
    try {
      await processAuthor(deps, author, posts, (count) => {
        postsFetched += count;
      });
    } catch (error) {
      posts.push({
        sourceUri: "",
        statusId: "",
        authorHandle: author.handle,
        outcome: "failed",
        skipReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  asanaTasksCreated = posts.filter((p) => p.outcome === "tasked").length;

  return {
    runKey: deps.runKey,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: deps.gateway.dryRun,
    authorsPolled: activeAuthors.length,
    postsFetched,
    newPostsProcessed: posts.length,
    asanaTasksCreated,
    posts,
  };
}

async function processAuthor(
  deps: RunMonitorDeps,
  author: WatchedAuthor,
  posts: PostOutcome[],
  recordFetched: (count: number) => void,
): Promise<void> {
  const usersByHandle = await deps.xClient.resolveUserIds([author.handle]);
  const user = usersByHandle.get(author.handle.toLowerCase());
  if (!user) {
    posts.push({
      sourceUri: "",
      statusId: "",
      authorHandle: author.handle,
      outcome: "failed",
      skipReason: "user-not-found",
    });
    return;
  }

  const cursor = await deps.cursorStore.getCursor(author.handle);
  const { posts: rawPosts, includes } = await deps.xClient.fetchRecentPosts(user.id, {
    sinceId: cursor ?? undefined,
    maxResults: deps.settings.defaultMaxPostsPerAuthor,
  });
  recordFetched(rawPosts.length);

  const usersById = new Map((includes.users ?? []).map((u) => [u.id, u]));
  usersById.set(user.id, user);
  const tweetsById = new Map((includes.tweets ?? []).map((t) => [t.id, t]));

  // Process oldest-first so the cursor advances monotonically even if a
  // later post in this batch fails.
  const sortedRawPosts = [...rawPosts].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));

  let newestStatusId: string | null = cursor;

  for (const rawPost of sortedRawPosts) {
    const post = parsePost(rawPost, author.handle);
    const interaction = classifyInteraction(rawPost, { usersById, tweetsById });

    if (interaction.referencedStatusId && !tweetsById.has(interaction.referencedStatusId)) {
      // Referenced original not inlined in `includes` -- batch-resolve it
      // so it's available for the task notes even though matching/drafting
      // always uses the watched author's own post text (see README's
      // "the X post" wording in the required MCP query shape).
      const { posts: referencedPosts } = await deps.xClient.fetchPostsByIds([
        interaction.referencedStatusId,
      ]);
      const referencedTweet = referencedPosts[0];
      if (referencedTweet) {
        tweetsById.set(referencedTweet.id, referencedTweet);
      }
    }

    if (isNewerStatusId(post.statusId, newestStatusId)) {
      newestStatusId = post.statusId;
    }

    const outcome = await processPost(deps, author, post, interaction);
    posts.push(outcome);
  }

  if (newestStatusId && newestStatusId !== cursor) {
    await deps.gateway.writeCursor(author.handle, newestStatusId);
  }
}

async function processPost(
  deps: RunMonitorDeps,
  author: WatchedAuthor,
  post: ParsedPost,
  interaction: ReturnType<typeof classifyInteraction>,
): Promise<PostOutcome> {
  const base = { sourceUri: post.sourceUri, statusId: post.statusId, authorHandle: author.handle };

  const alreadyProcessed = await deps.dedupeStore.hasProcessed(post.sourceUri, post.statusId);
  if (alreadyProcessed) {
    return { ...base, outcome: "skipped", skipReason: "already-processed" };
  }

  const matchResult = await getTopSoofiArticleSimilarities({
    mcpClient: deps.mcpClient,
    breaker: deps.breaker,
    postText: post.text,
    topK: deps.settings.defaultTopK,
  });

  // An MCP failure does NOT automatically skip Asana tasking -- it's
  // treated as "no similarity data available" (topArticles: []) and falls
  // through to the normal asanaTaskSimilarityThreshold gate, matching the
  // reference implementation: a threshold of 0 ("always create if other
  // checks pass") still creates a parent task with minimal notes so a
  // human can manually triage the post even when the corpus match failed.
  // Only when nothing gets created AND the reason was this MCP failure do
  // we label the outcome "failed" (rather than "skipped") in the summary.
  const topArticles = matchResult.ok ? matchResult.matches : [];
  const mcpFailureReason = matchResult.ok ? null : matchResult.reason;

  const qualifyingArticles = topArticles.filter((article) =>
    meetsArticleThreshold(article.rawScore, deps.settings.articleSimilarityThreshold),
  );

  let qualifyingOutcomes: ArticleOutcomePair[] = [];
  if (qualifyingArticles.length > 0) {
    const draftOutcomes = await generateDraftReplies({
      model: deps.model,
      langsmith: deps.langsmith,
      systemPrompt: deps.promptSet.systemPrompt,
      constraints: deps.promptSet.constraints,
      maxReplyCharacters: deps.settings.maxReplyCharacters,
      post,
      articles: qualifyingArticles,
      replySlots: deps.promptSet.replySlots,
      runKey: deps.runKey,
    });

    qualifyingOutcomes = draftOutcomes.map((outcome) => {
      const article = qualifyingArticles.find(
        (candidate) => candidate.sourceUri === outcome.articleSourceUri,
      );
      if (!article) {
        throw new Error(
          `Drafted outcome referenced an unknown article sourceUri: ${outcome.articleSourceUri}`,
        );
      }
      return { article, outcome };
    });
  }

  const taskingResult = await deps.gateway.processAsanaTasking({
    authorDisplayName: author.author,
    excludedTaskAuthors: deps.settings.excludedTaskAuthors,
    asanaTaskSimilarityThreshold: deps.settings.asanaTaskSimilarityThreshold,
    articleSimilarityThreshold: deps.settings.articleSimilarityThreshold,
    post,
    interaction,
    topArticles,
    qualifyingOutcomes,
  });

  if (taskingResult.created) {
    await deps.gateway.writeDedupeKey({
      sourceUri: post.sourceUri,
      statusId: post.statusId,
      outcome: "tasked",
      asanaTaskGid: taskingResult.parentTaskGid,
    });
    return {
      ...base,
      outcome: "tasked",
      asanaTaskGid: taskingResult.parentTaskGid,
      asanaTaskUrl: taskingResult.parentTaskUrl,
      subtaskCount: taskingResult.subtasks.length,
    };
  }

  // Prefer the more specific MCP failure reason over the tasking gate's
  // generic "below-similarity-threshold:none<..." when that's actually why
  // nothing was created -- and record it as "failed" (a real dependency
  // error), not "skipped" (a normal business-rule outcome), per the
  // acceptance criteria's "ingested, skipped, tasked, failed" outcomes.
  const outcome = mcpFailureReason ? "failed" : "skipped";
  const skipReason = mcpFailureReason ?? taskingResult.reason;

  if (taskingResult.reason !== "dry-run") {
    await deps.gateway.writeDedupeKey({
      sourceUri: post.sourceUri,
      statusId: post.statusId,
      outcome,
    });
  }
  return { ...base, outcome, skipReason };
}
