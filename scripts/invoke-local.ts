#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createDraftingModel } from "../src/agent/bedrock-model";
import { generateDraftReplies } from "../src/agent/draft-replies";
import { loadRuntimeEnv } from "../src/config/env";
import { loadSettings } from "../src/config/settings";
import { getTopSoofiArticleSimilarities } from "../src/matching/get-top-article-similarities";
import type { ArticleSimilarity } from "../src/matching/similarity-gating";
import { createCircuitBreaker } from "../src/mcp/circuit-breaker";
import { createInvestorMcpClient } from "../src/mcp/investors-mcp-client";
import { createLangSmithFacade } from "../src/observability/langsmith";
import { loadPromptSet } from "../src/prompts/load-prompts";
import { classifyInteraction } from "../src/x/interaction";
import { parsePost } from "../src/x/parse-post";
import type { RawTweet, RawUser } from "../src/x/types";

/**
 * Local, no-deploy verification harness. By default runs entirely against
 * an in-memory X fixture -- no real X API credentials, DynamoDB, LLM, or
 * Asana calls are made. Flags progressively opt into real external calls:
 *
 *   --live-mcp   Calls the real hosted investors-mcp MCP (public,
 *                read-only, no credentials required) with the fixture
 *                post's text.
 *   --live-llm   Drafts real replies via Amazon Bedrock (your AWS
 *                credentials/region) using the real config/prompts/*
 *                files, traced through LangSmith if LANGSMITH_* env vars
 *                are set. Uses the --live-mcp match if available, else a
 *                clearly-labeled synthetic fixture article so this flag
 *                works standalone. This one costs real (small) money and
 *                needs your own Bedrock model access -- see
 *                docs/implementation-plan.md, "Testing & local verification".
 *
 * Usage: npm run invoke:local -- --author exampleauthor --dry-run [--live-mcp] [--live-llm]
 */

const FIXTURE_AUTHOR: RawUser = { id: "1001", username: "exampleauthor", name: "Example Author" };
const FIXTURE_REFERENCED_AUTHOR: RawUser = {
  id: "2002",
  username: "originalauthor",
  name: "Original Author",
};

// One new reply from the watched author. Deliberately does NOT inline its
// referenced original in `includes.tweets`, so resolving it below exercises
// the same "referenced original not inlined -> batch-resolve" path a real
// deep-thread reply would (acceptance criterion: "detect and process
// referenced originals when a watched author replies to or quotes another
// post").
const FIXTURE_NEW_REPLY: RawTweet = {
  id: "1234567890123456791",
  text: "@originalauthor Interesting take — how does this hold up when property records leave silos?",
  author_id: FIXTURE_AUTHOR.id,
  created_at: "2026-01-02T12:00:00.000Z",
  in_reply_to_user_id: FIXTURE_REFERENCED_AUTHOR.id,
  referenced_tweets: [{ type: "replied_to", id: "1234567890123456780" }],
};

const FIXTURE_REFERENCED_ORIGINAL: RawTweet = {
  id: "1234567890123456780",
  text: "Property records leaving silos is the whole thesis — truth becomes programmable.",
  author_id: FIXTURE_REFERENCED_AUTHOR.id,
  created_at: "2026-01-02T09:00:00.000Z",
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      author: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "live-mcp": { type: "boolean", default: false },
      "live-llm": { type: "boolean", default: false },
    },
  });

  const author = values.author ?? FIXTURE_AUTHOR.username;
  const dryRun = values["dry-run"] ?? false;
  const liveMcp = values["live-mcp"] ?? false;
  const liveLlm = values["live-llm"] ?? false;

  console.log(
    `[invoke-local] author=${author} dryRun=${dryRun} (fixture data, no live X credentials used)`,
  );

  if (author.toLowerCase() !== FIXTURE_AUTHOR.username.toLowerCase()) {
    console.log(
      `[invoke-local] no fixture data for "${author}" — only "${FIXTURE_AUTHOR.username}" is stubbed today.`,
    );
    return;
  }

  // Simulates: fetchRecentPosts(userId, { sinceId: cursor }) -> [reply],
  // then fetchPostsByIds([referencedStatusId]) -> [referenced original].
  const usersById = new Map([
    [FIXTURE_AUTHOR.id, FIXTURE_AUTHOR],
    [FIXTURE_REFERENCED_AUTHOR.id, FIXTURE_REFERENCED_AUTHOR],
  ]);
  const referencedTweetsById = new Map([
    [FIXTURE_REFERENCED_ORIGINAL.id, FIXTURE_REFERENCED_ORIGINAL],
  ]);

  const post = parsePost(FIXTURE_NEW_REPLY, author);
  const interaction = classifyInteraction(FIXTURE_NEW_REPLY, {
    usersById,
    tweetsById: referencedTweetsById,
  });

  console.log("\n--- New post detected ---");
  console.log(JSON.stringify(post, null, 2));
  console.log(`interaction: ${interaction.type}`);

  if (interaction.referencedStatusId) {
    const referencedTweet = referencedTweetsById.get(interaction.referencedStatusId);
    if (referencedTweet) {
      const referencedPost = parsePost(
        referencedTweet,
        interaction.referencedAuthorHandle ?? "unknown",
      );
      console.log("\n--- Referenced original (resolved via fetchPostsByIds) ---");
      console.log(JSON.stringify(referencedPost, null, 2));
    } else {
      console.log(
        `\n--- Referenced original ${interaction.referencedStatusId} could not be resolved ---`,
      );
    }
  }

  let liveMcpMatches: ArticleSimilarity[] = [];
  if (liveMcp) {
    console.log("\n--- Live MCP article match (https://investors-mcp.vercel.app/mcp) ---");
    const mcpClient = createInvestorMcpClient();
    const breaker = createCircuitBreaker(3);
    try {
      const result = await getTopSoofiArticleSimilarities({
        mcpClient,
        breaker,
        postText: post.text,
        topK: 40,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.ok) {
        liveMcpMatches = result.matches;
      }
    } finally {
      await mcpClient.close();
    }
  }

  if (liveLlm) {
    console.log("\n--- Live LLM drafting (Amazon Bedrock via Vercel AI SDK) ---");
    const settings = loadSettings();
    const promptSet = loadPromptSet();
    const env = loadRuntimeEnv();
    const model = createDraftingModel(settings.modelId, env);
    const langsmith = await createLangSmithFacade(env);
    const runKey = `invoke-local-${Date.now()}`;

    const articles: ArticleSimilarity[] =
      liveMcpMatches.length > 0
        ? liveMcpMatches
        : [
            {
              rawScore: 0.75,
              score: 75,
              title: "Synthetic fixture article (no --live-mcp match available)",
              sourceUri: "https://x.com/i/article/fixture",
              excerpt: FIXTURE_REFERENCED_ORIGINAL.text,
              contextExcerpt: FIXTURE_REFERENCED_ORIGINAL.text,
            },
          ];

    console.log(`LangSmith tracing enabled: ${langsmith.tracingEnabled}, runKey=${runKey}`);
    console.log(`modelId=${settings.modelId}, region=${env.AWS_REGION}`);

    const outcomes = await generateDraftReplies({
      model,
      langsmith,
      systemPrompt: promptSet.systemPrompt,
      constraints: promptSet.constraints,
      maxReplyCharacters: settings.maxReplyCharacters,
      post,
      articles,
      replySlots: promptSet.replySlots,
      runKey,
    });

    console.log(JSON.stringify(outcomes, null, 2));
    await langsmith.flush();
  }

  if (dryRun) {
    const skipped = [!liveMcp && "MCP", !liveLlm && "LLM"].filter(Boolean).join("/");
    console.log(
      `\n[invoke-local] dry-run: no state writes, no Asana calls (not wired until Phase 5).` +
        (skipped ? ` ${skipped} not queried (pass --live-mcp/--live-llm to include).` : ""),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
