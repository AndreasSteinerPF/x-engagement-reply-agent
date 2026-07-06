#!/usr/bin/env node
import { parseArgs } from "node:util";
import { classifyInteraction } from "../src/x/interaction";
import { parsePost } from "../src/x/parse-post";
import type { RawTweet, RawUser } from "../src/x/types";

/**
 * Local, no-deploy verification harness for the X polling + interaction
 * classification pipeline (Phase 2). Runs entirely against an in-memory
 * fixture -- no real X API credentials, DynamoDB, MCP, LLM, or Asana calls
 * are made from this script yet. Later phases extend this file with
 * --live-mcp, --live-llm, and real state/Asana wiring as those pieces land
 * (see docs/implementation-plan.md, "Testing & local verification").
 *
 * Usage: npm run invoke:local -- --author exampleauthor --dry-run
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
    },
  });

  const author = values.author ?? FIXTURE_AUTHOR.username;
  const dryRun = values["dry-run"] ?? false;

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

  if (dryRun) {
    console.log(
      "\n[invoke-local] dry-run: no state writes, no MCP/LLM/Asana calls (not wired until Phase 3-5).",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
