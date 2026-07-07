import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AsanaClient,
  AsanaParentResult,
  AsanaParentTaskParams,
  AsanaSubtaskParams,
  AsanaSubtaskResult,
} from "../../ports.js";
import {
  buildAsanaRecommendationSubtaskNotes,
  buildAsanaSimilarityTaskNotes,
  composeIntentLink,
  parentTaskName,
  subtaskName,
} from "./notes.js";

/**
 * Offline Asana sink — the default when no Asana credentials are present. It
 * builds the exact parent-task and approval-subtask payloads {@link LiveAsanaClient}
 * would POST and writes them as JSON to `<outDir>/asana/`, so reviewers can
 * inspect precisely what would be created (including the X compose intent links)
 * without an Asana workspace.
 *
 * In dry-run it writes nothing and reports `reason: "dry-run"`, guaranteeing the
 * "no side effects" contract at the adapter boundary.
 */
export class OfflineAsanaClient implements AsanaClient {
  constructor(
    private readonly outDir: string,
    private readonly thresholds: { asanaTaskSimilarityThreshold: number; articleSimilarityThreshold: number },
  ) {}

  async createParentTask(params: AsanaParentTaskParams): Promise<AsanaParentResult> {
    if (params.dryRun) return { created: false, reason: "dry-run", gid: `dry-${params.post.statusId}` };

    const gid = `offline-${params.post.statusId}`;
    const payload = {
      kind: "asana.parent_task",
      gid,
      name: parentTaskName(params.watch, params.post),
      notes: buildAsanaSimilarityTaskNotes({
        watch: params.watch,
        post: params.post,
        recommendations: params.recommendations,
        topRawScore: params.topRawScore,
        topScore100: params.topScore100,
        thresholds: this.thresholds,
        thresholdMet: params.thresholdMet,
      }),
      custom_fields: { similarity_score: params.topScore100 },
      assignee: params.thresholdMet ? "${ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID}" : "${ASANA_ASSIGNEE_GID}",
      due_on: params.thresholdMet ? today() : undefined,
      permalink_url: `https://app.asana.com/0/offline/${params.post.statusId}`,
    };
    await this.write(`parent-${params.post.statusId}.json`, payload);
    return { created: true, gid, permalinkUrl: payload.permalink_url };
  }

  async createRecommendationSubtasks(params: AsanaSubtaskParams): Promise<AsanaSubtaskResult> {
    if (params.dryRun) return { created: 0, gids: [], reason: "dry-run" };

    const gids: string[] = [];
    for (const rec of params.recommendations) {
      for (const response of rec.suggestedResponses) {
        const gid = `offline-sub-${params.post.statusId}-${response.promptIndex}-${slug(rec.sourceUri)}`;
        const payload = {
          kind: "asana.approval_subtask",
          gid,
          parent: params.parentTaskGid,
          name: subtaskName(response.promptLabel, rec.title),
          resource_subtype: "approval",
          approval_status: "pending",
          notes: buildAsanaRecommendationSubtaskNotes({ recommendation: rec, post: params.post, response }),
          custom_fields: { similarity_score: rec.score100, draft_reply: response.text },
          compose_intent_url: composeIntentLink(params.post.statusId, response.text),
        };
        await this.write(`subtask-${params.post.statusId}-${response.promptIndex}-${slug(rec.sourceUri)}.json`, payload);
        gids.push(gid);
      }
    }
    return { created: gids.length, gids };
  }

  private async write(name: string, payload: unknown): Promise<void> {
    const dir = join(this.outDir, "asana");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(payload, null, 2), "utf8");
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function slug(uri: string): string {
  return uri.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-24);
}
