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
  parentTaskName,
  subtaskName,
} from "./notes.js";

const ASANA_BASE = "https://app.asana.com/api/1.0";

export interface LiveAsanaConfig {
  accessToken: string;
  projectGid: string;
  sectionGid?: string;
  workspaceGid?: string;
  assigneeGid?: string;
  thresholdAssigneeGid?: string;
  /** Resolved custom-field GIDs for the similarity score. */
  parentFieldGid?: string;
  subtaskFieldGid?: string;
}

/**
 * Live Asana client. Faithful to the reference `createAsanaTask` /
 * `createAsanaRecommendationSubtasks`: a parent task per qualifying post, an
 * approval subtask per (article x prompt), threshold-based assignee + same-day
 * due date, and similarity custom fields. Activates only when an Asana token +
 * project are configured (not provided for this milestone, so shipped unexercised).
 */
export class LiveAsanaClient implements AsanaClient {
  constructor(private readonly cfg: LiveAsanaConfig) {}

  static fromEnv(): LiveAsanaClient | null {
    const accessToken = process.env.ASANA_ACCESS_TOKEN;
    const projectGid = process.env.ASANA_PROJECT_GID;
    if (!accessToken || !projectGid) return null;
    const shared = process.env.ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID || "";
    const parentFieldGid = process.env.ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID || shared || undefined;
    const subtaskFieldGid =
      process.env.ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID || shared || parentFieldGid || undefined;
    return new LiveAsanaClient({
      accessToken,
      projectGid,
      sectionGid: process.env.ASANA_SECTION_GID,
      workspaceGid: process.env.ASANA_WORKSPACE_GID,
      assigneeGid: process.env.ASANA_ASSIGNEE_GID,
      thresholdAssigneeGid: process.env.ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID,
      parentFieldGid,
      subtaskFieldGid,
    });
  }

  async createParentTask(params: AsanaParentTaskParams): Promise<AsanaParentResult> {
    if (params.dryRun) return { created: false, reason: "dry-run" };

    const data: Record<string, unknown> = {
      name: parentTaskName(params.watch, params.post),
      notes: buildAsanaSimilarityTaskNotes({
        watch: params.watch,
        post: params.post,
        recommendations: params.recommendations,
        topRawScore: params.topRawScore,
        topScore100: params.topScore100,
        thresholds: {
          asanaTaskSimilarityThreshold: 0,
          articleSimilarityThreshold: 0,
        },
        thresholdMet: params.thresholdMet,
      }),
      projects: [this.cfg.projectGid],
    };
    if (this.cfg.workspaceGid) data.workspace = this.cfg.workspaceGid;
    if (this.cfg.parentFieldGid) data.custom_fields = { [this.cfg.parentFieldGid]: params.topScore100 };
    const assignee = params.thresholdMet ? this.cfg.thresholdAssigneeGid ?? this.cfg.assigneeGid : this.cfg.assigneeGid;
    if (assignee) data.assignee = assignee;
    if (params.thresholdMet) data.due_on = new Date().toISOString().slice(0, 10);

    const res = await this.post<{ data?: { gid: string; permalink_url?: string } }>(
      `/tasks?opt_fields=gid,permalink_url`,
      { data },
    );
    const gid = res.data?.gid;
    if (!gid) return { created: false, reason: "asana-no-gid" };
    if (this.cfg.sectionGid) {
      await this.post(`/sections/${this.cfg.sectionGid}/addTask`, { data: { task: gid } }).catch(() => undefined);
    }
    return { created: true, gid, permalinkUrl: res.data?.permalink_url };
  }

  async createRecommendationSubtasks(params: AsanaSubtaskParams): Promise<AsanaSubtaskResult> {
    if (params.dryRun) return { created: 0, gids: [], reason: "dry-run" };
    const gids: string[] = [];
    for (const rec of params.recommendations) {
      for (const response of rec.suggestedResponses) {
        const data: Record<string, unknown> = {
          name: subtaskName(response.promptLabel, rec.title),
          notes: buildAsanaRecommendationSubtaskNotes({ recommendation: rec, post: params.post, response }),
          resource_subtype: "approval",
          approval_status: "pending",
        };
        if (this.cfg.subtaskFieldGid) data.custom_fields = { [this.cfg.subtaskFieldGid]: rec.score100 };
        if (this.cfg.assigneeGid) data.assignee = this.cfg.assigneeGid;
        const res = await this.post<{ data?: { gid: string } }>(
          `/tasks/${params.parentTaskGid}/subtasks?opt_fields=gid,name,permalink_url`,
          { data },
        );
        if (res.data?.gid) gids.push(res.data.gid);
      }
    }
    return { created: gids.length, gids };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${ASANA_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Asana ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
