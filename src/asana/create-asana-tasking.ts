import type { DraftReplyOutcome } from "../agent/draft-replies";
import type { RuntimeEnv } from "../config/env";
import { meetsAsanaTaskThreshold } from "../matching/similarity-gating";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import { truncateToHeader } from "../util/text";
import type { InteractionResult } from "../x/interaction";
import type { ParsedPost } from "../x/parse-post";
import type { AsanaClient } from "./client";
import { buildSimilarityCustomFields, resolveSimilarityFieldGids } from "./custom-fields";
import type { AsanaDedupeCache } from "./dedupe";
import { buildParentTaskNotes, buildSubtaskNotes } from "./notes";

const SUBTASK_NAME_MAX_LENGTH = 110;

export type ArticleOutcomePair = {
  article: ArticleSimilarity;
  outcome: DraftReplyOutcome;
};

export type CreateAsanaTaskingParams = {
  asanaClient: AsanaClient;
  dedupeCache: AsanaDedupeCache;
  env: RuntimeEnv;
  authorDisplayName: string;
  excludedTaskAuthors: string[];
  asanaTaskSimilarityThreshold: number;
  articleSimilarityThreshold: number;
  post: ParsedPost;
  interaction: InteractionResult;
  topArticles: ArticleSimilarity[];
  qualifyingOutcomes: ArticleOutcomePair[];
};

export type CreatedAsanaSubtask = {
  gid: string;
  url: string;
  articleSourceUri: string;
  promptLabel: string;
};

export type AsanaTaskingResult =
  | { created: false; reason: string }
  | {
      created: true;
      parentTaskGid: string;
      parentTaskUrl: string;
      subtasks: CreatedAsanaSubtask[];
    };

/**
 * Creates the parent Asana task and one approval subtask per (qualifying
 * article x prompt-slot outcome), per docs/implementation-plan.md's Asana
 * integration section (ported from investors-mcp's createAsanaTask /
 * createAsanaRecommendationSubtasks, adapted to this agent's flatter data
 * shapes). Callers are expected to have already filtered `qualifyingOutcomes`
 * to articles clearing `articleSimilarityThreshold` -- this function only
 * handles the parent-task gate (`asanaTaskSimilarityThreshold`, evaluated
 * against ALL `topArticles` regardless of the article-level threshold),
 * dedupe, and the actual Asana writes.
 */
export async function createAsanaTasking(
  params: CreateAsanaTaskingParams,
): Promise<AsanaTaskingResult> {
  const {
    asanaClient,
    dedupeCache,
    env,
    authorDisplayName,
    excludedTaskAuthors,
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
    post,
    interaction,
    topArticles,
    qualifyingOutcomes,
  } = params;

  if (
    excludedTaskAuthors.some(
      (excluded) => excluded.toLowerCase() === authorDisplayName.toLowerCase(),
    )
  ) {
    return { created: false, reason: "excluded-author" };
  }

  // Only ASANA_PROJECT_GID is checked here -- the access token requirement
  // is already enforced by the time `asanaClient` was constructed (real
  // Lambda: handler.ts's requireEnv() on the resolved secret; here it's
  // just an opaque client). Checking env.ASANA_ACCESS_TOKEN directly was a
  // stale leftover from before ASANA_ACCESS_TOKEN_SECRET_ARN existed: the
  // deployed Lambda deliberately never sets the plaintext env var anymore
  // (see src/config/resolve-secret.ts), so this check always failed there
  // even with a perfectly valid, real Asana client -- only ever caught by
  // an actual deployed run, since invoke-local.ts always passes the plain
  // env var directly.
  if (!env.ASANA_PROJECT_GID) {
    return { created: false, reason: "missing-asana-config" };
  }
  const projectGid = env.ASANA_PROJECT_GID;

  const bestCandidateRawScore =
    topArticles.length > 0 ? Math.max(...topArticles.map((a) => a.rawScore)) : null;
  if (!meetsAsanaTaskThreshold(bestCandidateRawScore, asanaTaskSimilarityThreshold)) {
    const scoreLabel = bestCandidateRawScore === null ? "none" : bestCandidateRawScore.toFixed(4);
    return {
      created: false,
      reason: `below-similarity-threshold:${scoreLabel}<${asanaTaskSimilarityThreshold.toFixed(4)}`,
    };
  }

  const dedupeEnabled = env.ASANA_EXISTING_TASK_DEDUPE_ENABLED !== "false";
  if (dedupeEnabled) {
    const existing = await dedupeCache.findExistingTaskForPost({
      projectGid,
      sourceUri: post.sourceUri,
      statusId: post.statusId,
    });
    if (existing) {
      return { created: false, reason: "already-tasked-existing-task" };
    }
  }

  const articlesMetThreshold = qualifyingOutcomes.length > 0;
  const { parentTaskFieldGid, subtaskFieldGid } = resolveSimilarityFieldGids(env);

  const parentPayload: Record<string, unknown> = {
    name: `Draft response: ${authorDisplayName} - ${post.header}`,
    notes: buildParentTaskNotes({
      post,
      interaction,
      topArticles,
      asanaTaskSimilarityThreshold,
      articleSimilarityThreshold,
      bestCandidateRawScore,
    }),
    projects: [projectGid],
  };
  if (env.ASANA_WORKSPACE_GID) {
    parentPayload.workspace = env.ASANA_WORKSPACE_GID;
  }
  const parentCustomFields = buildSimilarityCustomFields(parentTaskFieldGid, bestCandidateRawScore);
  if (parentCustomFields) {
    parentPayload.custom_fields = parentCustomFields;
  }
  if (articlesMetThreshold && env.ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID) {
    parentPayload.assignee = env.ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID;
    parentPayload.due_on = new Date().toISOString().slice(0, 10);
  } else if (env.ASANA_ASSIGNEE_GID) {
    parentPayload.assignee = env.ASANA_ASSIGNEE_GID;
  }

  const parentTask = await asanaClient.createTask(parentPayload);

  if (env.ASANA_SECTION_GID) {
    await asanaClient.addTaskToSection(parentTask.gid, env.ASANA_SECTION_GID);
  }

  const subtasks: CreatedAsanaSubtask[] = [];
  for (const { article, outcome } of qualifyingOutcomes) {
    const articleLabel = article.title || article.sourceUri;
    const subtaskPayload: Record<string, unknown> = {
      name: truncateToHeader(
        `Approve X Reply - ${outcome.promptLabel}: ${articleLabel}`,
        SUBTASK_NAME_MAX_LENGTH,
      ),
      notes: buildSubtaskNotes({ post, article, outcome }),
      resource_subtype: "approval",
      approval_status: "pending",
    };
    const subtaskCustomFields = buildSimilarityCustomFields(subtaskFieldGid, article.rawScore);
    if (subtaskCustomFields) {
      subtaskPayload.custom_fields = subtaskCustomFields;
    }
    if (env.ASANA_ASSIGNEE_GID) {
      subtaskPayload.assignee = env.ASANA_ASSIGNEE_GID;
    }

    const subtask = await asanaClient.createSubtask(parentTask.gid, subtaskPayload);
    subtasks.push({
      gid: subtask.gid,
      url: subtask.permalinkUrl,
      articleSourceUri: article.sourceUri,
      promptLabel: outcome.promptLabel,
    });
  }

  return {
    created: true,
    parentTaskGid: parentTask.gid,
    parentTaskUrl: parentTask.permalinkUrl,
    subtasks,
  };
}
