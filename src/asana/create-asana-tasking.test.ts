import { describe, expect, it, vi } from "vitest";
import type { DraftReplyOutcome } from "../agent/draft-replies";
import type { RuntimeEnv } from "../config/env";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { InteractionResult } from "../x/interaction";
import type { ParsedPost } from "../x/parse-post";
import type { AsanaClient } from "./client";
import { createAsanaTasking } from "./create-asana-tasking";
import type { AsanaDedupeCache } from "./dedupe";

const POST: ParsedPost = {
  statusId: "123",
  sourceUri: "https://x.com/exampleauthor/status/123",
  authorId: "1",
  authorHandle: "exampleauthor",
  header: "Example post",
  text: "Interesting take on property records.",
  contentType: "post",
  articleEnrichment: "not-applicable",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const INTERACTION: InteractionResult = { type: "original" };

const ARTICLE: ArticleSimilarity = {
  rawScore: 0.8,
  score: 82,
  title: "Web3 Property Ledgers",
  sourceUri: "https://x.com/i/article/1",
  excerpt: "excerpt",
  contextExcerpt: "context excerpt",
};

const OUTCOME: DraftReplyOutcome = {
  ok: true,
  promptIndex: 1,
  promptLabel: "Prompt 1 -- Recommend and draft",
  promptText: "Draft a reply grounded in the article.",
  articleSourceUri: ARTICLE.sourceUri,
  articleTitle: ARTICLE.title,
  articleScore: ARTICLE.score,
  draft: {
    draftText: "Interesting. What changes first?",
    quotedPhrase: "quoted",
    whyRecommended: "on-topic",
  },
};

function env(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    AWS_REGION: "us-east-2",
    ASANA_ACCESS_TOKEN: "token",
    ASANA_PROJECT_GID: "project-1",
    ...overrides,
  };
}

function fakeAsanaClient(overrides: Partial<AsanaClient> = {}): AsanaClient {
  return {
    createTask: vi
      .fn()
      .mockResolvedValue({ gid: "parent-1", permalinkUrl: "https://app.asana.com/parent-1" }),
    addTaskToSection: vi.fn().mockResolvedValue(undefined),
    createSubtask: vi
      .fn()
      .mockResolvedValue({ gid: "sub-1", permalinkUrl: "https://app.asana.com/sub-1" }),
    listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    ...overrides,
  };
}

function fakeDedupeCache(existing: null | { gid: string } = null): AsanaDedupeCache {
  return { findExistingTaskForPost: vi.fn().mockResolvedValue(existing) };
}

const BASE_PARAMS = {
  authorDisplayName: "Example Author",
  excludedTaskAuthors: [] as string[],
  asanaTaskSimilarityThreshold: 0,
  articleSimilarityThreshold: 0.7,
  post: POST,
  interaction: INTERACTION,
  topArticles: [ARTICLE],
  qualifyingOutcomes: [{ article: ARTICLE, outcome: OUTCOME }],
};

describe("createAsanaTasking", () => {
  it("skips excluded authors without calling Asana at all", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      excludedTaskAuthors: ["Example Author"],
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });

    expect(result).toEqual({ created: false, reason: "excluded-author" });
    expect(asanaClient.createTask).not.toHaveBeenCalled();
  });

  it("matches excluded authors case-insensitively", async () => {
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      excludedTaskAuthors: ["example author"],
      asanaClient: fakeAsanaClient(),
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });
    expect(result).toEqual({ created: false, reason: "excluded-author" });
  });

  it("returns missing-asana-config when credentials or project gid are absent", async () => {
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient: fakeAsanaClient(),
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_ACCESS_TOKEN: undefined }),
    });
    expect(result).toEqual({ created: false, reason: "missing-asana-config" });
  });

  it("gates parent-task creation on asanaTaskSimilarityThreshold using the best raw score across topArticles", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      asanaTaskSimilarityThreshold: 0.9, // ARTICLE.rawScore is 0.8 -- below this
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });

    expect(result.created).toBe(false);
    if (!result.created) expect(result.reason).toMatch(/^below-similarity-threshold/);
    expect(asanaClient.createTask).not.toHaveBeenCalled();
  });

  it("always allows parent-task creation when the threshold is 0, even with no candidate articles", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      topArticles: [],
      qualifyingOutcomes: [],
      asanaTaskSimilarityThreshold: 0,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });

    expect(result.created).toBe(true);
    expect(asanaClient.createTask).toHaveBeenCalledTimes(1);
  });

  it("skips creation when an existing task is already found via dedupe", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache({ gid: "existing-1" }),
      env: env(),
    });

    expect(result).toEqual({ created: false, reason: "already-tasked-existing-task" });
    expect(asanaClient.createTask).not.toHaveBeenCalled();
  });

  it("skips the dedupe check entirely when ASANA_EXISTING_TASK_DEDUPE_ENABLED is 'false'", async () => {
    const dedupeCache = fakeDedupeCache();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient: fakeAsanaClient(),
      dedupeCache,
      env: env({ ASANA_EXISTING_TASK_DEDUPE_ENABLED: "false" }),
    });

    expect(dedupeCache.findExistingTaskForPost).not.toHaveBeenCalled();
  });

  it("creates the parent task with name, notes, and projects", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });

    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.name).toBe("Draft response: Example Author - Example post");
    expect(payload.projects).toEqual(["project-1"]);
    expect(payload.notes).toContain(POST.sourceUri);
  });

  it("sets workspace only when ASANA_WORKSPACE_GID is configured", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_WORKSPACE_GID: "workspace-1" }),
    });
    expect((asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0].workspace).toBe(
      "workspace-1",
    );

    const asanaClient2 = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient: asanaClient2,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });
    expect(
      (asanaClient2.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0].workspace,
    ).toBeUndefined();
  });

  it("adds the task to a section only when ASANA_SECTION_GID is configured", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_SECTION_GID: "section-1" }),
    });
    expect(asanaClient.addTaskToSection).toHaveBeenCalledWith("parent-1", "section-1");

    const asanaClient2 = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient: asanaClient2,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });
    expect(asanaClient2.addTaskToSection).not.toHaveBeenCalled();
  });

  it("sets the threshold assignee and today's due date when an article met the threshold and the env var is set", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID: "threshold-assignee" }),
    });

    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.assignee).toBe("threshold-assignee");
    expect(payload.due_on).toBe(new Date().toISOString().slice(0, 10));
  });

  it("falls back to the default assignee when no article met the threshold", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      qualifyingOutcomes: [],
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({
        ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID: "threshold-assignee",
        ASANA_ASSIGNEE_GID: "default-assignee",
      }),
    });

    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.assignee).toBe("default-assignee");
    expect(payload.due_on).toBeUndefined();
  });

  it("sets no assignee when neither env var is configured", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });
    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.assignee).toBeUndefined();
  });

  it("sets parent custom_fields from the best candidate score when a field gid is configured", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "field-1" }),
    });
    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.custom_fields).toEqual({ "field-1": 0.8 });
  });

  it("omits custom_fields entirely when no field gid is configured", async () => {
    const asanaClient = fakeAsanaClient();
    await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });
    const payload = (asanaClient.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.custom_fields).toBeUndefined();
  });

  it("creates one subtask per qualifying (article, outcome) pair with the right shape", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env({ ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "field-1" }),
    });

    expect(asanaClient.createSubtask).toHaveBeenCalledTimes(1);
    const [parentGid, payload] = (asanaClient.createSubtask as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(parentGid).toBe("parent-1");
    expect(payload.name).toBe(
      "Approve X Reply - Prompt 1 -- Recommend and draft: Web3 Property Ledgers",
    );
    expect(payload.resource_subtype).toBe("approval");
    expect(payload.approval_status).toBe("pending");
    expect(payload.custom_fields).toEqual({ "field-1": 0.8 });

    expect(result).toMatchObject({
      created: true,
      parentTaskGid: "parent-1",
      parentTaskUrl: "https://app.asana.com/parent-1",
      subtasks: [
        {
          gid: "sub-1",
          url: "https://app.asana.com/sub-1",
          articleSourceUri: ARTICLE.sourceUri,
          promptLabel: OUTCOME.promptLabel,
        },
      ],
    });
  });

  it("creates zero subtasks when there are no qualifying outcomes", async () => {
    const asanaClient = fakeAsanaClient();
    const result = await createAsanaTasking({
      ...BASE_PARAMS,
      qualifyingOutcomes: [],
      asanaClient,
      dedupeCache: fakeDedupeCache(),
      env: env(),
    });

    expect(asanaClient.createSubtask).not.toHaveBeenCalled();
    if (result.created) expect(result.subtasks).toEqual([]);
  });
});
