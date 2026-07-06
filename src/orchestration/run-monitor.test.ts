import { describe, expect, it, vi } from "vitest";
import type { AsanaTaskingResult } from "../asana/create-asana-tasking";
import type { WatchedAuthor } from "../config/watchlist";
import type { MonitorSettings } from "../config/settings";
import {
  createDryRunSideEffectGateway,
  type SideEffectGateway,
} from "../effects/side-effect-gateway";
import { createCircuitBreaker } from "../mcp/circuit-breaker";
import type { InvestorMcpClient, QueryInvestorContentResponse } from "../mcp/investors-mcp-client";
import type { LangSmithFacade } from "../observability/langsmith";
import type { PromptSet } from "../prompts/load-prompts";
import type { CursorStore } from "../state/cursor-store";
import type { DedupeStore } from "../state/dedupe-store";
import { XRateLimitError, type XClient } from "../x/client";
import type { RawTweet, RawUser } from "../x/types";
import { runMonitor, type RunMonitorDeps } from "./run-monitor";

const AUTHOR: WatchedAuthor = {
  author: "Example Author",
  handle: "exampleauthor",
  company: "example-co",
  aliases: { handles: [], authors: [] },
  active: true,
};

const FIXTURE_USER: RawUser = { id: "1001", username: "exampleauthor", name: "Example Author" };
const FIXTURE_REFERENCED_AUTHOR: RawUser = {
  id: "2002",
  username: "originalauthor",
  name: "Original Author",
};

const FIXTURE_REPLY: RawTweet = {
  id: "1234567890123456791",
  text: "@originalauthor thoughts on property records leaving silos?",
  author_id: FIXTURE_USER.id,
  created_at: "2026-01-02T12:00:00.000Z",
  in_reply_to_user_id: FIXTURE_REFERENCED_AUTHOR.id,
  referenced_tweets: [{ type: "replied_to", id: "1234567890123456780" }],
};

const FIXTURE_REFERENCED_TWEET: RawTweet = {
  id: "1234567890123456780",
  text: "Property records leaving silos is the whole thesis.",
  author_id: FIXTURE_REFERENCED_AUTHOR.id,
};

const MATCH_RESPONSE: QueryInvestorContentResponse = {
  query: "q",
  topK: 20,
  matchCount: 1,
  matches: [
    {
      id: "m1",
      score: 0.8,
      key: "k1",
      metadata: {},
      blob: {
        sourceUri: "https://x.com/i/article/1",
        title: "Web3 Property Ledgers",
        content:
          "Property records leaving silos is the whole thesis, and truth becomes programmable.",
      },
    },
  ],
};

const SETTINGS: MonitorSettings = {
  pollIntervalMinutes: 2,
  defaultBatchSize: 5,
  defaultMaxPostsPerAuthor: 20,
  defaultTopK: 20,
  asanaTaskSimilarityThreshold: 0,
  articleSimilarityThreshold: 0.7,
  modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
  dedupeTtlDays: 90,
  backfillHours: 24,
  costCeilingUsdPerRun: 5,
  excludedTaskAuthors: [],
  maxReplyCharacters: 280,
};

const PROMPT_SET: PromptSet = {
  systemPrompt: "You draft replies.",
  constraints: "Max 280 chars.",
  replySlots: [
    {
      promptIndex: 1,
      promptLabel: "Prompt 1",
      fileName: "01-x.md",
      content: "Draft a reply.",
      endsWithQuestion: true,
    },
  ],
};

function fakeXClient(overrides: Partial<XClient> = {}): XClient {
  return {
    resolveUserIds: vi.fn().mockResolvedValue(new Map([["exampleauthor", FIXTURE_USER]])),
    fetchRecentPosts: vi.fn().mockResolvedValue({
      posts: [FIXTURE_REPLY],
      includes: { users: [FIXTURE_USER] },
    }),
    fetchPostsByIds: vi.fn().mockResolvedValue({
      posts: [FIXTURE_REFERENCED_TWEET],
      includes: { users: [FIXTURE_REFERENCED_AUTHOR] },
    }),
    ...overrides,
  };
}

function fakeMcpClient(overrides: Partial<InvestorMcpClient> = {}): InvestorMcpClient {
  return {
    queryInvestorContent: vi.fn().mockResolvedValue(MATCH_RESPONSE),
    listInvestorContent: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function fakeLangsmith(): LangSmithFacade {
  return {
    tracingEnabled: false,
    generateObject: vi.fn().mockResolvedValue({
      object: {
        draftText:
          "Interesting -- property records leaving silos changes everything. What comes next?",
        quotedPhrase: "Property records leaving silos is the whole thesis",
        whyRecommended: "on-topic",
      },
    }),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeCursorStore(cursor: string | null = null): CursorStore {
  return {
    getCursor: vi.fn().mockResolvedValue(cursor),
    setCursor: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeDedupeStore(hasProcessed = false): DedupeStore {
  return {
    hasProcessed: vi.fn().mockResolvedValue(hasProcessed),
    markProcessed: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeGateway(overrides: Partial<SideEffectGateway> = {}): SideEffectGateway {
  return {
    dryRun: false,
    processAsanaTasking: vi.fn().mockResolvedValue({
      created: true,
      parentTaskGid: "p1",
      parentTaskUrl: "url",
      subtasks: [{}],
    } as AsanaTaskingResult),
    writeCursor: vi.fn().mockResolvedValue(undefined),
    writeDedupeKey: vi.fn().mockResolvedValue(undefined),
    writeRunSummary: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<RunMonitorDeps> = {}): RunMonitorDeps {
  return {
    xClient: fakeXClient(),
    mcpClient: fakeMcpClient(),
    breaker: createCircuitBreaker(3),
    model: {} as never,
    langsmith: fakeLangsmith(),
    cursorStore: fakeCursorStore(),
    dedupeStore: fakeDedupeStore(),
    gateway: fakeGateway(),
    settings: SETTINGS,
    promptSet: PROMPT_SET,
    watchlist: [AUTHOR],
    runKey: "run-1",
    ...overrides,
  };
}

describe("runMonitor", () => {
  it("processes a new post end-to-end and creates an Asana task", async () => {
    const gateway = fakeGateway();
    const summary = await runMonitor(baseDeps({ gateway }));

    expect(summary.authorsPolled).toBe(1);
    expect(summary.postsFetched).toBe(1);
    expect(summary.newPostsProcessed).toBe(1);
    expect(summary.asanaTasksCreated).toBe(1);
    expect(summary.posts[0]).toMatchObject({
      sourceUri: "https://x.com/exampleauthor/status/1234567890123456791",
      outcome: "tasked",
      asanaTaskGid: "p1",
      asanaTaskUrl: "url",
      subtaskCount: 1,
    });
  });

  it("resolves the referenced original via fetchPostsByIds and passes it through to Asana tasking", async () => {
    const gateway = fakeGateway();
    const xClient = fakeXClient();
    await runMonitor(baseDeps({ gateway, xClient }));

    expect(xClient.fetchPostsByIds).toHaveBeenCalledWith(["1234567890123456780"]);
    const taskingCall = (gateway.processAsanaTasking as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskingCall.interaction.type).toBe("reply");
    expect(taskingCall.interaction.referencedStatusId).toBe("1234567890123456780");
  });

  it("marks the post tasked in the dedupe store and advances the cursor", async () => {
    const gateway = fakeGateway();
    await runMonitor(baseDeps({ gateway }));

    expect(gateway.writeDedupeKey).toHaveBeenCalledWith({
      sourceUri: "https://x.com/exampleauthor/status/1234567890123456791",
      statusId: "1234567890123456791",
      outcome: "tasked",
      asanaTaskGid: "p1",
    });
    expect(gateway.writeCursor).toHaveBeenCalledWith("exampleauthor", "1234567890123456791");
  });

  it("skips a post already marked processed in the dedupe store, without calling MCP or Asana", async () => {
    const mcpClient = fakeMcpClient();
    const gateway = fakeGateway();
    const summary = await runMonitor(
      baseDeps({ dedupeStore: fakeDedupeStore(true), mcpClient, gateway }),
    );

    expect(summary.posts[0]).toMatchObject({ outcome: "skipped", skipReason: "already-processed" });
    expect(mcpClient.queryInvestorContent).not.toHaveBeenCalled();
    expect(gateway.processAsanaTasking).not.toHaveBeenCalled();
  });

  it("records outcome 'failed' with the MCP reason when nothing gets created because matching failed", async () => {
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const langsmith = fakeLangsmith();
    const gateway = fakeGateway({
      processAsanaTasking: vi
        .fn()
        .mockResolvedValue({ created: false, reason: "below-similarity-threshold:none<0.5000" }),
    });
    const summary = await runMonitor(
      baseDeps({
        mcpClient,
        langsmith,
        gateway,
        settings: { ...SETTINGS, asanaTaskSimilarityThreshold: 0.5 },
      }),
    );

    // The MCP-specific reason is preferred over the tasking gate's generic
    // reason, and the outcome is "failed" (a dependency error) rather than
    // "skipped" (a normal business-rule outcome).
    expect(summary.posts[0].outcome).toBe("failed");
    expect(summary.posts[0].skipReason).toBe("mcp-query-failed");
    expect(langsmith.generateObject).not.toHaveBeenCalled();
    expect(gateway.processAsanaTasking).toHaveBeenCalledWith(
      expect.objectContaining({ qualifyingOutcomes: [], topArticles: [] }),
    );
  });

  it("still allows a parent task to be created on MCP failure when asanaTaskSimilarityThreshold is 0", async () => {
    // Matches the reference's own behavior: threshold 0 means "always
    // create if other checks pass," even without similarity data, so a
    // human can still manually triage the post.
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const gateway = fakeGateway(); // default: created: true
    const summary = await runMonitor(
      baseDeps({ mcpClient, gateway, settings: { ...SETTINGS, asanaTaskSimilarityThreshold: 0 } }),
    );

    expect(summary.posts[0].outcome).toBe("tasked");
    expect(gateway.processAsanaTasking).toHaveBeenCalledWith(
      expect.objectContaining({ qualifyingOutcomes: [], topArticles: [] }),
    );
  });

  it("never drafts replies for articles that don't clear articleSimilarityThreshold", async () => {
    const belowThresholdResponse: QueryInvestorContentResponse = {
      ...MATCH_RESPONSE,
      matches: [{ ...MATCH_RESPONSE.matches[0], score: 0.5 }],
    };
    const mcpClient = fakeMcpClient({
      queryInvestorContent: vi.fn().mockResolvedValue(belowThresholdResponse),
    });
    const langsmith = fakeLangsmith();
    const gateway = fakeGateway();
    await runMonitor(
      baseDeps({
        mcpClient,
        langsmith,
        gateway,
        settings: { ...SETTINGS, articleSimilarityThreshold: 0.7 },
      }),
    );

    expect(langsmith.generateObject).not.toHaveBeenCalled();
    const taskingCall = (gateway.processAsanaTasking as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskingCall.qualifyingOutcomes).toEqual([]);
    expect(taskingCall.topArticles).toHaveLength(1); // still passed through for parent-task notes/gating
  });

  it("dry-run mode reports the dry-run reason and the run summary flags dryRun: true", async () => {
    const summary = await runMonitor(baseDeps({ gateway: createDryRunSideEffectGateway() }));

    expect(summary.dryRun).toBe(true);
    expect(summary.posts[0]).toMatchObject({ outcome: "skipped", skipReason: "dry-run" });
    expect(summary.asanaTasksCreated).toBe(0);
  });

  it("records a failed outcome for the author without crashing the whole run", async () => {
    const xClient = fakeXClient({
      resolveUserIds: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const summary = await runMonitor(baseDeps({ xClient }));

    expect(summary.posts).toEqual([
      {
        sourceUri: "",
        statusId: "",
        authorHandle: "exampleauthor",
        outcome: "failed",
        skipReason: "network down",
      },
    ]);
  });

  it("records a failed outcome when the handle can't be resolved to a user", async () => {
    const xClient = fakeXClient({ resolveUserIds: vi.fn().mockResolvedValue(new Map()) });
    const summary = await runMonitor(baseDeps({ xClient }));

    expect(summary.posts[0]).toMatchObject({ outcome: "failed", skipReason: "user-not-found" });
  });

  it("skips inactive authors entirely", async () => {
    const xClient = fakeXClient();
    const summary = await runMonitor(
      baseDeps({ xClient, watchlist: [{ ...AUTHOR, active: false }] }),
    );

    expect(summary.authorsPolled).toBe(0);
    expect(xClient.resolveUserIds).not.toHaveBeenCalled();
  });

  it("bounds a first-ever poll (no cursor) to backfillHours instead of full history", async () => {
    const fetchRecentPosts = vi.fn().mockResolvedValue({ posts: [], includes: {} });
    const xClient = fakeXClient({ fetchRecentPosts });
    const fixedNow = new Date("2026-01-10T00:00:00.000Z");

    await runMonitor(
      baseDeps({ xClient, cursorStore: fakeCursorStore(null), now: () => fixedNow }),
    );

    expect(fetchRecentPosts).toHaveBeenCalledWith(
      FIXTURE_USER.id,
      expect.objectContaining({ sinceId: undefined, startTime: "2026-01-09T00:00:00.000Z" }),
    );
  });

  it("does not bound by startTime once a cursor already exists", async () => {
    const fetchRecentPosts = vi.fn().mockResolvedValue({ posts: [], includes: {} });
    const xClient = fakeXClient({ fetchRecentPosts });

    await runMonitor(baseDeps({ xClient, cursorStore: fakeCursorStore("500") }));

    const options = fetchRecentPosts.mock.calls[0][1] as { sinceId?: string; startTime?: string };
    expect(options.sinceId).toBe("500");
    expect(options.startTime).toBeUndefined();
  });

  it("stops processing remaining authors when X rate-limits the run, without a retry cascade", async () => {
    const secondAuthor: WatchedAuthor = {
      ...AUTHOR,
      handle: "secondauthor",
      author: "Second Author",
    };
    const secondUser: RawUser = { id: "3003", username: "secondauthor", name: "Second Author" };
    const resolveUserIds = vi.fn().mockImplementation(async (handles: string[]) => {
      const handle = handles[0]?.toLowerCase();
      if (handle === "exampleauthor") return new Map([["exampleauthor", FIXTURE_USER]]);
      if (handle === "secondauthor") return new Map([["secondauthor", secondUser]]);
      return new Map();
    });
    const fetchRecentPosts = vi
      .fn()
      .mockRejectedValue(new XRateLimitError({ remaining: 0, resetEpochSeconds: 1_780_000_000 }));
    const xClient = fakeXClient({ resolveUserIds, fetchRecentPosts });

    const summary = await runMonitor(baseDeps({ xClient, watchlist: [AUTHOR, secondAuthor] }));

    expect(summary.stoppedEarlyReason).toBe("rate-limited");
    expect(summary.posts).toHaveLength(1);
    expect(summary.posts[0]).toMatchObject({ authorHandle: "exampleauthor", outcome: "failed" });
    expect(summary.posts[0].skipReason).toContain("rate-limited");
    // The second author is never even attempted -- no cascade of identical
    // rate-limit failures.
    expect(resolveUserIds).toHaveBeenCalledTimes(1);
  });
});
