import { describe, expect, it, vi } from "vitest";
import type { AsanaClient } from "../asana/client";
import type { AsanaDedupeCache } from "../asana/dedupe";
import type { RuntimeEnv } from "../config/env";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { RunSummary } from "../orchestration/run-monitor";
import type { CursorStore } from "../state/cursor-store";
import type { DedupeStore } from "../state/dedupe-store";
import type { RotationStore } from "../state/rotation-store";
import type { RunSummaryStore } from "../state/run-summary-store";
import type { InteractionResult } from "../x/interaction";
import type { ParsedPost } from "../x/parse-post";
import { createDryRunSideEffectGateway, createLiveSideEffectGateway } from "./side-effect-gateway";

const POST: ParsedPost = {
  statusId: "123",
  sourceUri: "https://x.com/exampleauthor/status/123",
  authorId: "1",
  authorHandle: "exampleauthor",
  header: "Example post",
  text: "text",
  contentType: "post",
  articleEnrichment: "not-applicable",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const INTERACTION: InteractionResult = { type: "original" };
const ARTICLE: ArticleSimilarity = {
  rawScore: 0.8,
  score: 82,
  title: "t",
  sourceUri: "https://x.com/i/article/1",
  excerpt: "e",
  contextExcerpt: "e",
};

const PROCESS_PARAMS = {
  authorDisplayName: "Example Author",
  excludedTaskAuthors: [],
  asanaTaskSimilarityThreshold: 0,
  articleSimilarityThreshold: 0.7,
  post: POST,
  interaction: INTERACTION,
  topArticles: [ARTICLE],
  qualifyingOutcomes: [],
};

const RUN_SUMMARY: RunSummary = {
  runKey: "run-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  dryRun: false,
  authorsPolled: 1,
  postsFetched: 1,
  newPostsProcessed: 1,
  asanaTasksCreated: 1,
  posts: [],
};

describe("createDryRunSideEffectGateway", () => {
  it("flags dryRun as true", () => {
    expect(createDryRunSideEffectGateway().dryRun).toBe(true);
  });

  it("returns a synthetic dry-run result without any external calls", async () => {
    const gateway = createDryRunSideEffectGateway();
    const result = await gateway.processAsanaTasking(PROCESS_PARAMS);
    expect(result).toEqual({ created: false, reason: "dry-run" });
  });

  it("writeCursor, writeDedupeKey, writeRunSummary, and writeRotationCursor are all safe no-ops", async () => {
    const gateway = createDryRunSideEffectGateway();
    await expect(gateway.writeCursor("handle", "123")).resolves.toBeUndefined();
    await expect(
      gateway.writeDedupeKey({ sourceUri: "uri", statusId: "1", outcome: "skipped" }),
    ).resolves.toBeUndefined();
    await expect(gateway.writeRunSummary(RUN_SUMMARY)).resolves.toBeUndefined();
    await expect(gateway.writeRotationCursor(3)).resolves.toBeUndefined();
  });
});

describe("createLiveSideEffectGateway", () => {
  function fakeAsanaClient(): AsanaClient {
    return {
      createTask: vi.fn().mockResolvedValue({ gid: "parent-1", permalinkUrl: "url" }),
      addTaskToSection: vi.fn(),
      createSubtask: vi.fn(),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    };
  }

  function fakeDedupeCache(): AsanaDedupeCache {
    return { findExistingTaskForPost: vi.fn().mockResolvedValue(null) };
  }

  function fakeCursorStore(): CursorStore {
    return {
      getCursor: vi.fn().mockResolvedValue(null),
      setCursor: vi.fn().mockResolvedValue(undefined),
    };
  }

  function fakeDedupeStore(): DedupeStore {
    return {
      hasProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };
  }

  function fakeRunSummaryStore(): RunSummaryStore {
    return { writeRunSummary: vi.fn().mockResolvedValue(undefined) };
  }

  function fakeRotationStore(): RotationStore {
    return {
      getCursorIndex: vi.fn().mockResolvedValue(0),
      setCursorIndex: vi.fn().mockResolvedValue(undefined),
    };
  }

  function env(): RuntimeEnv {
    return { AWS_REGION: "us-east-2", ASANA_ACCESS_TOKEN: "token", ASANA_PROJECT_GID: "project-1" };
  }

  function deps(overrides: Partial<Parameters<typeof createLiveSideEffectGateway>[0]> = {}) {
    return {
      asanaClient: fakeAsanaClient(),
      dedupeCache: fakeDedupeCache(),
      env: env(),
      cursorStore: fakeCursorStore(),
      dedupeStore: fakeDedupeStore(),
      runSummaryStore: fakeRunSummaryStore(),
      rotationStore: fakeRotationStore(),
      ...overrides,
    };
  }

  it("flags dryRun as false", () => {
    expect(createLiveSideEffectGateway(deps()).dryRun).toBe(false);
  });

  it("delegates processAsanaTasking to the real Asana client, binding env/dedupeCache from construction", async () => {
    const asanaClient = fakeAsanaClient();
    const dedupeCache = fakeDedupeCache();
    const gateway = createLiveSideEffectGateway(deps({ asanaClient, dedupeCache }));

    const result = await gateway.processAsanaTasking(PROCESS_PARAMS);

    expect(result.created).toBe(true);
    expect(asanaClient.createTask).toHaveBeenCalledTimes(1);
    expect(dedupeCache.findExistingTaskForPost).toHaveBeenCalledTimes(1);
  });

  it("delegates writeCursor to the real cursor store", async () => {
    const cursorStore = fakeCursorStore();
    const gateway = createLiveSideEffectGateway(deps({ cursorStore }));

    await gateway.writeCursor("exampleauthor", "999");

    expect(cursorStore.setCursor).toHaveBeenCalledWith("exampleauthor", "999");
  });

  it("delegates writeDedupeKey to the real dedupe store", async () => {
    const dedupeStore = fakeDedupeStore();
    const gateway = createLiveSideEffectGateway(deps({ dedupeStore }));

    await gateway.writeDedupeKey({
      sourceUri: "uri",
      statusId: "1",
      outcome: "tasked",
      asanaTaskGid: "gid-1",
    });

    expect(dedupeStore.markProcessed).toHaveBeenCalledWith({
      sourceUri: "uri",
      statusId: "1",
      outcome: "tasked",
      asanaTaskGid: "gid-1",
    });
  });

  it("delegates writeRunSummary to the real run-summary store", async () => {
    const runSummaryStore = fakeRunSummaryStore();
    const gateway = createLiveSideEffectGateway(deps({ runSummaryStore }));

    await gateway.writeRunSummary(RUN_SUMMARY);

    expect(runSummaryStore.writeRunSummary).toHaveBeenCalledWith(RUN_SUMMARY);
  });

  it("delegates writeRotationCursor to the real rotation store", async () => {
    const rotationStore = fakeRotationStore();
    const gateway = createLiveSideEffectGateway(deps({ rotationStore }));

    await gateway.writeRotationCursor(2);

    expect(rotationStore.setCursorIndex).toHaveBeenCalledWith(2);
  });
});
