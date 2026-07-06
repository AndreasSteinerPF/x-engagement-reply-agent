#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createDraftingModel } from "../src/agent/bedrock-model";
import { createAsanaClient } from "../src/asana/client";
import { createAsanaDedupeCache } from "../src/asana/dedupe";
import { loadRuntimeEnv } from "../src/config/env";
import { loadSettings } from "../src/config/settings";
import { loadWatchlist } from "../src/config/watchlist";
import {
  createDryRunSideEffectGateway,
  createLiveSideEffectGateway,
  type SideEffectGateway,
} from "../src/effects/side-effect-gateway";
import { createCircuitBreaker } from "../src/mcp/circuit-breaker";
import {
  createInvestorMcpClient,
  type InvestorMcpClient,
  type QueryInvestorContentResponse,
} from "../src/mcp/investors-mcp-client";
import { createLangSmithFacade, type LangSmithFacade } from "../src/observability/langsmith";
import { runMonitor } from "../src/orchestration/run-monitor";
import { loadPromptSet } from "../src/prompts/load-prompts";
import type { CursorStore } from "../src/state/cursor-store";
import type { DedupeStore, MarkProcessedParams } from "../src/state/dedupe-store";
import type { XClient } from "../src/x/client";
import type { RawTweet, RawUser } from "../src/x/types";

/**
 * Local, no-deploy verification harness that runs the REAL runMonitor()
 * orchestrator (the same function handler.ts calls in Lambda) against an
 * in-memory X fixture and in-memory cursor/dedupe state -- no real X API
 * credentials or DynamoDB access needed. Flags progressively opt into real
 * external calls for the pieces that DO have safe or candidate-supplied
 * credentials available:
 *
 *   --live-mcp    Matches against the real hosted investors-mcp MCP
 *                 (public, read-only, no credentials required).
 *   --live-llm    Drafts real replies via Amazon Bedrock (your AWS
 *                 credentials/region), traced through LangSmith if
 *                 LANGSMITH_* env vars are set. Costs real (small) money.
 *   --live-asana  Creates a real Asana parent task + subtasks (your
 *                 ASANA_ACCESS_TOKEN / ASANA_PROJECT_GID env vars) in a
 *                 sandbox project. Falls back to a clear warning + the
 *                 dry-run gateway if those aren't configured.
 *   --dry-run     Forces the dry-run gateway regardless of --live-asana --
 *                 zero Asana network calls, synthetic result only.
 *
 * Cursor/dedupe state is always in-memory and fresh per invocation --
 * this script never touches real DynamoDB, so it's safe to re-run.
 *
 * Usage: npm run invoke:local -- --author exampleauthor --dry-run [--live-mcp] [--live-llm] [--live-asana]
 */

const FIXTURE_AUTHOR: RawUser = { id: "1001", username: "exampleauthor", name: "Example Author" };
const FIXTURE_REFERENCED_AUTHOR: RawUser = {
  id: "2002",
  username: "originalauthor",
  name: "Original Author",
};

// One new reply from the watched author. Deliberately does NOT inline its
// referenced original in `includes.tweets`, so resolving it exercises the
// same "referenced original not inlined -> batch-resolve" path a real
// deep-thread reply would (acceptance criterion: "detect and process
// referenced originals when a watched author replies to or quotes another
// post").
const FIXTURE_REPLY: RawTweet = {
  id: "1234567890123456791",
  text: "@originalauthor Interesting take — how does this hold up when property records leave silos?",
  author_id: FIXTURE_AUTHOR.id,
  created_at: "2026-01-02T12:00:00.000Z",
  in_reply_to_user_id: FIXTURE_REFERENCED_AUTHOR.id,
  referenced_tweets: [{ type: "replied_to", id: "1234567890123456780" }],
};

const FIXTURE_REFERENCED_TWEET: RawTweet = {
  id: "1234567890123456780",
  text: "Property records leaving silos is the whole thesis — truth becomes programmable.",
  author_id: FIXTURE_REFERENCED_AUTHOR.id,
  created_at: "2026-01-02T09:00:00.000Z",
};

const FIXTURE_MATCH_RESPONSE: QueryInvestorContentResponse = {
  query: "fixture",
  topK: 20,
  matchCount: 1,
  matches: [
    {
      id: "fixture-match-1",
      score: 0.75,
      key: "fixture-key",
      metadata: {},
      blob: {
        sourceUri: "https://x.com/i/article/fixture",
        title: "Synthetic fixture article (no --live-mcp match available)",
        content: FIXTURE_REFERENCED_TWEET.text,
      },
    },
  ],
};

function createFixtureXClient(): XClient {
  return {
    resolveUserIds: async (handles) => {
      const map = new Map<string, RawUser>();
      if (handles.some((h) => h.toLowerCase() === FIXTURE_AUTHOR.username)) {
        map.set(FIXTURE_AUTHOR.username, FIXTURE_AUTHOR);
      }
      return map;
    },
    fetchRecentPosts: async () => ({
      posts: [FIXTURE_REPLY],
      includes: { users: [FIXTURE_AUTHOR] },
    }),
    fetchPostsByIds: async (ids) => {
      if (ids.includes(FIXTURE_REFERENCED_TWEET.id)) {
        return {
          posts: [FIXTURE_REFERENCED_TWEET],
          includes: { users: [FIXTURE_REFERENCED_AUTHOR] },
        };
      }
      return { posts: [], includes: {} };
    },
  };
}

function createFixtureMcpClient(): InvestorMcpClient {
  return {
    queryInvestorContent: async () => FIXTURE_MATCH_RESPONSE,
    listInvestorContent: async () => ({ items: [] }),
    close: async () => {},
  };
}

function createFixtureLangsmith(): LangSmithFacade {
  return {
    tracingEnabled: false,
    generateObject: (async (params: { prompt?: string }) => ({
      object: {
        draftText: "Interesting -- what changes first once property records leave silos?",
        quotedPhrase: "Property records leaving silos is the whole thesis",
        whyRecommended: `Fixture draft (no --live-llm); prompt length ${params.prompt?.length ?? 0} chars.`,
      },
    })) as unknown as LangSmithFacade["generateObject"],
    flush: async () => {},
  };
}

function createInMemoryCursorStore(): CursorStore {
  const cursors = new Map<string, string>();
  return {
    getCursor: async (handle) => cursors.get(handle.toLowerCase()) ?? null,
    setCursor: async (handle, statusId) => {
      cursors.set(handle.toLowerCase(), statusId);
    },
  };
}

function createInMemoryDedupeStore(): DedupeStore {
  const processed = new Map<string, MarkProcessedParams>();
  function key(sourceUri: string, statusId: string): string {
    return `${sourceUri}#${statusId}`;
  }
  return {
    hasProcessed: async (sourceUri, statusId) => processed.has(key(sourceUri, statusId)),
    markProcessed: async (params) => {
      processed.set(key(params.sourceUri, params.statusId), params);
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      author: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "live-mcp": { type: "boolean", default: false },
      "live-llm": { type: "boolean", default: false },
      "live-asana": { type: "boolean", default: false },
    },
  });

  const author = values.author ?? FIXTURE_AUTHOR.username;
  const dryRun = values["dry-run"] ?? false;
  const liveMcp = values["live-mcp"] ?? false;
  const liveLlm = values["live-llm"] ?? false;
  const liveAsana = values["live-asana"] ?? false;

  console.log(
    `[invoke-local] author=${author} dryRun=${dryRun} liveMcp=${liveMcp} liveLlm=${liveLlm} liveAsana=${liveAsana}`,
  );

  const settings = loadSettings();
  const promptSet = loadPromptSet();
  const fullWatchlist = loadWatchlist();
  const watchlist = fullWatchlist.filter(
    (entry) => entry.handle.toLowerCase() === author.toLowerCase(),
  );
  if (watchlist.length === 0) {
    console.log(`[invoke-local] "${author}" is not in config/watchlist.yaml -- add it first.`);
    return;
  }
  // Only the "exampleauthor" fixture has X data wired up below; other
  // watchlist entries will correctly resolve to a "user-not-found" outcome.
  watchlist[0] = { ...watchlist[0], active: true };

  const xClient = createFixtureXClient();
  const breaker = createCircuitBreaker(3);
  const cursorStore = createInMemoryCursorStore();
  const dedupeStore = createInMemoryDedupeStore();

  const mcpClient = liveMcp ? createInvestorMcpClient() : createFixtureMcpClient();
  if (liveMcp) console.log("[invoke-local] MCP: live (https://investors-mcp.vercel.app/mcp)");

  const env = loadRuntimeEnv();
  const model = liveLlm ? createDraftingModel(settings.modelId, env) : ({} as never);
  const langsmith = liveLlm ? await createLangSmithFacade(env) : createFixtureLangsmith();
  if (liveLlm) {
    console.log(`[invoke-local] LLM: live (modelId=${settings.modelId}, region=${env.AWS_REGION})`);
    console.log(`[invoke-local] LangSmith tracing enabled: ${langsmith.tracingEnabled}`);
  }

  let gateway: SideEffectGateway;
  if (!dryRun && liveAsana && env.ASANA_ACCESS_TOKEN && env.ASANA_PROJECT_GID) {
    const asanaClient = createAsanaClient({ accessToken: env.ASANA_ACCESS_TOKEN });
    const dedupeCache = createAsanaDedupeCache({ asanaClient });
    gateway = createLiveSideEffectGateway({
      asanaClient,
      dedupeCache,
      env,
      cursorStore,
      dedupeStore,
      runSummaryStore: { writeRunSummary: async () => {} }, // no real DynamoDB locally
    });
    console.log(`[invoke-local] Asana: live (project=${env.ASANA_PROJECT_GID})`);
  } else {
    if (liveAsana && !dryRun) {
      console.log(
        "[invoke-local] --live-asana requested but ASANA_ACCESS_TOKEN/ASANA_PROJECT_GID are not set -- falling back to dry-run for Asana.",
      );
    }
    gateway = createDryRunSideEffectGateway();
  }

  const runKey = `invoke-local-${Date.now()}`;
  const summary = await runMonitor({
    xClient,
    mcpClient,
    breaker,
    model,
    langsmith,
    cursorStore,
    dedupeStore,
    gateway,
    settings,
    promptSet,
    watchlist,
    runKey,
  });

  console.log("\n--- Run summary ---");
  console.log(JSON.stringify(summary, null, 2));

  await langsmith.flush();
  await mcpClient.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
