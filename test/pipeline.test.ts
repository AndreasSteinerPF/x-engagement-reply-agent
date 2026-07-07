import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { runMonitor, type RunDeps, type RunOptions } from "../src/pipeline/run.js";
import { MemoryStateStore } from "../src/state/file-store.js";
import { OfflineAsanaClient } from "../src/adapters/asana/offline.js";
import { NullTraceSink } from "../src/obs/trace.js";
import { Logger } from "../src/obs/logger.js";
import type { MatchedArticle } from "../src/ports.js";
import {
  FakeMatcher,
  FakeXClient,
  makeArticle,
  makeConfig,
  makeGenerator,
  makePost,
  makePrompt,
  makeWatchAuthor,
} from "./helpers.js";

const MODES = { x: "fixture", llm: "deterministic", asana: "offline" };

/** Count the JSON files the OfflineAsanaClient wrote under <outDir>/asana. */
async function asanaFileCount(outDir: string): Promise<number> {
  const dir = join(outDir, "asana");
  if (!existsSync(dir)) return 0;
  return (await readdir(dir)).filter((f) => f.endsWith(".json")).length;
}

describe("runMonitor pipeline", () => {
  let outDir: string;
  let asanaOutDir: string;

  beforeEach(async () => {
    // Separate dirs: run artifacts (.out/runs) vs asana sink, so we can count asana files cleanly.
    outDir = await mkdtemp(join(tmpdir(), "x-out-"));
    asanaOutDir = await mkdtemp(join(tmpdir(), "x-asana-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(asanaOutDir, { recursive: true, force: true });
  });

  /** Build RunDeps with the supplied matcher/x-client/state/config. */
  function makeDeps(p: {
    matcher: FakeMatcher;
    xClient: FakeXClient;
    state: MemoryStateStore;
    config?: ReturnType<typeof makeConfig>;
  }): RunDeps {
    const config = p.config ?? makeConfig();
    return {
      config,
      xClient: p.xClient,
      matcher: p.matcher,
      generator: makeGenerator(),
      asana: new OfflineAsanaClient(asanaOutDir, {
        asanaTaskSimilarityThreshold: config.settings.asanaTaskSimilarityThreshold,
        articleSimilarityThreshold: config.settings.articleSimilarityThreshold,
      }),
      state: p.state,
      trace: new NullTraceSink(),
      logger: new Logger({ pretty: false }),
      outDir,
      modes: MODES,
    };
  }

  const baseOpts: RunOptions = { runId: "test-run", dryRun: false };

  it("a post above threshold -> parent task + (articles*prompts) subtasks", async () => {
    const article = makeArticle({ rawScore: 0.82 }); // >= 0.72 default threshold
    const post = makePost({ text: "on-topic post about property records" });
    const matcher = new FakeMatcher(new Map([[post.text, [article]]]));
    const xClient = new FakeXClient([post]);
    const config = makeConfig({ replyPrompts: [makePrompt(1), makePrompt(2), makePrompt(3)] });
    const deps = makeDeps({ matcher, xClient, state: new MemoryStateStore(), config });

    const { summary } = await runMonitor(deps, baseOpts);

    const recommendedCount = 1; // one article clears the threshold
    const prompts = config.replyPrompts.length; // 3
    expect(summary.metrics.asanaParentTasksCreated).toBe(1);
    expect(summary.metrics.asanaSubtasksCreated).toBe(recommendedCount * prompts);
    // 1 parent file + (1*3) subtask files
    expect(await asanaFileCount(asanaOutDir)).toBe(1 + recommendedCount * prompts);
  });

  it("a post whose matches are all below threshold -> 0 subtasks", async () => {
    const below = makeArticle({ rawScore: 0.5 }); // < 0.72
    const post = makePost({ text: "off-topic post" });
    const matcher = new FakeMatcher(new Map([[post.text, [below]]]));
    const deps = makeDeps({ matcher, xClient: new FakeXClient([post]), state: new MemoryStateStore() });

    const { summary } = await runMonitor(deps, baseOpts);

    expect(summary.metrics.asanaSubtasksCreated).toBe(0);
    // task threshold is 0 (default) so a parent task is still created, but with no recommendations
    expect(await asanaFileCount(asanaOutDir)).toBe(1); // parent only, no subtasks
  });

  it("an excluded author's post is skipped (excluded-author), 0 subtasks", async () => {
    const article = makeArticle({ rawScore: 0.9 });
    const post = makePost({ handle: "ssafavi", author: "Soofi Safavi", text: "soofi's own post" });
    const matcher = new FakeMatcher(new Map([[post.text, [article]]]));
    const watch = makeWatchAuthor({ handle: "ssafavi", author: "Soofi Safavi" });
    const config = makeConfig({ watchlist: [watch] });
    const deps = makeDeps({ matcher, xClient: new FakeXClient([post]), state: new MemoryStateStore(), config });

    const { summary, artifact } = await runMonitor(deps, baseOpts);

    expect(summary.metrics.asanaSubtasksCreated).toBe(0);
    expect(summary.metrics.asanaParentTasksCreated).toBe(0);
    expect(summary.reasons["excluded-author"]).toBe(1);
    const rec = artifact.posts.find((r) => r.post.statusId === post.statusId);
    expect(rec?.reason).toBe("excluded-author");
    expect(await asanaFileCount(asanaOutDir)).toBe(0);
  });

  it("processes referenced posts (isReferenced true) and matches them too", async () => {
    const article = makeArticle({ rawScore: 0.82 });
    const post = makePost({ statusId: "2000", text: "reply that references an original" });
    const referenced = makePost({
      statusId: "1500",
      sourceUri: "https://x.com/someone/status/1500",
      handle: "someone",
      author: "Some One",
      text: "the original referenced post text",
    });
    const matcher = new FakeMatcher(
      new Map([
        [post.text, [article]],
        [referenced.text, [makeArticle({ sourceUri: "ref-article", rawScore: 0.82 })]],
      ]),
    );
    const xClient = new FakeXClient([post], new Map([[post.statusId, [referenced]]]));
    const deps = makeDeps({ matcher, xClient, state: new MemoryStateStore() });

    const { summary, artifact } = await runMonitor(deps, baseOpts);

    expect(summary.metrics.referencedPostsFetched).toBe(1);
    const refRecord = artifact.posts.find((r) => r.post.statusId === referenced.statusId);
    expect(refRecord).toBeDefined();
    expect(refRecord!.isReferenced).toBe(true);
  });

  it("running twice with a shared state store -> second run processes 0 new posts (dedup)", async () => {
    const article = makeArticle({ rawScore: 0.82 });
    const post = makePost({ text: "dedup post" });
    const matcher = new FakeMatcher(new Map([[post.text, [article]]]));
    const state = new MemoryStateStore();
    const deps = makeDeps({ matcher, xClient: new FakeXClient([post]), state });

    const first = await runMonitor(deps, { ...baseOpts, runId: "run-1" });
    expect(first.summary.metrics.newPostsProcessed).toBe(1);

    const second = await runMonitor(deps, { ...baseOpts, runId: "run-2" });
    expect(second.summary.metrics.newPostsProcessed).toBe(0);
  });

  it("dry-run: no parent tasks, no asana files, state untouched so a later real run still processes the post", async () => {
    const article = makeArticle({ rawScore: 0.82 });
    const post = makePost({ text: "dry run post" });
    const matcher = new FakeMatcher(new Map([[post.text, [article]]]));
    const state = new MemoryStateStore();
    const deps = makeDeps({ matcher, xClient: new FakeXClient([post]), state });

    const dry = await runMonitor(deps, { ...baseOpts, runId: "dry", dryRun: true });
    expect(dry.summary.metrics.asanaParentTasksCreated).toBe(0);
    expect(await asanaFileCount(asanaOutDir)).toBe(0);

    // State must be unchanged: processedKeys stays empty.
    const loaded = await state.loadState();
    expect(loaded.processedKeys).toEqual([]);

    // A subsequent non-dry run still processes the post.
    const real = await runMonitor(deps, { ...baseOpts, runId: "real" });
    expect(real.summary.metrics.newPostsProcessed).toBe(1);
    expect(real.summary.metrics.asanaParentTasksCreated).toBe(1);
  });

  it("adding a prompt file (5 -> 6) increases subtasks by exactly (recommended articles)", async () => {
    const article: MatchedArticle = makeArticle({ rawScore: 0.82 });
    const post = makePost({ text: "prompt-count post" });

    async function subtasksFor(promptCount: number): Promise<number> {
      const matcher = new FakeMatcher(new Map([[post.text, [article]]]));
      const config = makeConfig({
        replyPrompts: Array.from({ length: promptCount }, (_, i) => makePrompt(i + 1)),
      });
      // fresh state + fresh asana dir each time
      const deps = makeDeps({ matcher, xClient: new FakeXClient([post]), state: new MemoryStateStore(), config });
      const { summary } = await runMonitor(deps, { ...baseOpts, runId: `p${promptCount}` });
      return summary.metrics.asanaSubtasksCreated;
    }

    const recommendedArticleCount = 1; // single article clears threshold
    const five = await subtasksFor(5);
    const six = await subtasksFor(6);

    expect(five).toBe(5 * recommendedArticleCount);
    expect(six).toBe(6 * recommendedArticleCount);
    expect(six - five).toBe(recommendedArticleCount);
  });
});
