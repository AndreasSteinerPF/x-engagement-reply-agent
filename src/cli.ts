#!/usr/bin/env -S npx tsx
import { join } from "node:path";
import { loadConfig, PACKAGE_ROOT } from "./config/load.js";
import { createXClient } from "./adapters/x/index.js";
import { createReplyGenerator } from "./adapters/llm/index.js";
import { createAsanaClient } from "./adapters/asana/index.js";
import { McpArticleMatcher } from "./similarity.js";
import { McpClient } from "./mcp/client.js";
import { FileStateStore } from "./state/file-store.js";
import { TraceSink } from "./obs/trace.js";
import { Logger } from "./obs/logger.js";
import { runMonitor, type RunDeps, type RunOptions } from "./pipeline/run.js";
import { postRunSummary } from "./registry-client.js";

const AGENT_ID = "kestrel";

loadEnv();

main().catch((err) => {
  console.error("\x1b[31mfatal:\x1b[0m", err?.stack ?? err);
  process.exit(1);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const flags = parseFlags(argv.slice(1));

  if (command === "help" || flags.help) return printHelp();
  if (command === "config") return printConfig();
  if (command === "run") return void (await runOnce(flags));
  if (command === "loop") return loop(flags);

  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

async function buildDeps(): Promise<{ deps: RunDeps; runId: string }> {
  const config = await loadConfig();
  const outDir = process.env.OUT_DIR ?? join(PACKAGE_ROOT, ".out");
  const stateDir = process.env.STATE_DIR ?? join(PACKAGE_ROOT, ".state");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const logger = new Logger({ context: { agent: AGENT_ID } });
  const { client: xClient, mode: xMode } = createXClient();
  const { generator, mode: llmMode } = createReplyGenerator(config.settings.modelId);
  const { client: asana, mode: asanaMode } = createAsanaClient({
    outDir,
    thresholds: {
      asanaTaskSimilarityThreshold: config.settings.asanaTaskSimilarityThreshold,
      articleSimilarityThreshold: config.settings.articleSimilarityThreshold,
    },
  });

  const deps: RunDeps = {
    config,
    xClient,
    matcher: new McpArticleMatcher(new McpClient()),
    generator,
    asana,
    state: new FileStateStore(stateDir),
    trace: new TraceSink(join(outDir, "traces"), runId),
    logger,
    outDir,
    modes: { x: xMode, llm: llmMode === "offline" ? `offline (${generator.model})` : `${generator.provider}/${generator.model}`, asana: asanaMode },
  };
  return { deps, runId };
}

async function runOnce(flags: Flags): Promise<void> {
  const { deps, runId } = await buildDeps();
  const opts: RunOptions = {
    runId,
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags.force),
    authorFilter: str(flags.author),
    batchSize: num(flags["batch-size"]),
    maxPostsPerAuthor: num(flags["max-posts"]),
    topK: num(flags["top-k"]),
    agentId: AGENT_ID,
  };

  const banner = opts.dryRun ? "DRY-RUN (no Asana tasks, state untouched)" : "LIVE-LOCAL";
  deps.logger.info(`mode: ${banner}`, deps.modes);

  const { summary, artifact } = await runMonitor(deps, opts);
  printSummary(summary, artifact);

  const reportTo = str(flags["report-to"]) ?? process.env.PLATFORM_URL;
  if (reportTo && !opts.dryRun) {
    await postRunSummary(reportTo, summary, deps.logger);
  }
}

async function loop(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const intervalMin = num(flags.interval) ?? config.settings.pollIntervalMinutes;
  const intervalMs = intervalMin * 60_000;
  console.error(`\x1b[36mLooping every ${intervalMin} min. Ctrl-C to stop.\x1b[0m`);
  let stop = false;
  process.on("SIGINT", () => {
    console.error("\nstopping after current run…");
    stop = true;
  });
  for (;;) {
    await runOnce(flags).catch((err) => console.error("run error:", err?.message ?? err));
    if (stop) break;
    await sleep(intervalMs);
    if (stop) break;
  }
}

async function printConfig(): Promise<void> {
  const config = await loadConfig();
  console.log("Resolved configuration (loaded from version-controlled files — no admin UI, no DB):\n");
  console.log("settings:", JSON.stringify(config.settings, null, 2));
  console.log(
    "\nwatchlist:",
    config.watchlist.map((a) => `${a.author} (@${a.handle})${a.active ? "" : " [inactive]"}`).join("\n           "),
  );
  console.log("\nsystem prompt:", config.systemPrompt);
  console.log("\nresponse constraints:");
  for (const c of config.responseConstraints) console.log("  -", c);
  console.log(`\nreply prompts (${config.replyPrompts.length} slots, one per file):`);
  for (const p of config.replyPrompts) console.log(`  ${p.index}. ${p.label}  [${p.file}]  requireQuestion=${p.requireQuestion}`);
  console.log("\nFiles:");
  for (const [k, v] of Object.entries(config.paths)) console.log(`  ${k}: ${v}`);
}

function printSummary(summary: ReturnType<typeof Object>, artifact: { posts: Array<{ post: { handle: string; statusId: string }; isReferenced: boolean; outcome: string; reason?: string; matches: Array<{ rawScore: number; score100: number }>; recommendations: Array<{ suggestedResponses: unknown[] }>; subtasks?: { created: number } }> }): void {
  const s = summary as { metrics: Record<string, number>; status: string; durationMs: number; reasons: Record<string, number> };
  console.log("\n\x1b[1m── Run summary ──────────────────────────────\x1b[0m");
  console.log(`status=${s.status}  duration=${s.durationMs}ms`);
  const m = s.metrics;
  console.log(
    `authorsPolled=${m.authorsPolled} postsFetched=${m.postsFetched} new=${m.newPostsProcessed} referenced=${m.referencedPostsFetched}`,
  );
  console.log(
    `articlesMatched=${m.articlesMatched} repliesGenerated=${m.repliesGenerated} parentTasks=${m.asanaParentTasksCreated} subtasks=${m.asanaSubtasksCreated}`,
  );
  if (Object.keys(s.reasons).length) console.log("skips/failures:", JSON.stringify(s.reasons));
  console.log("\nper-post:");
  for (const p of artifact.posts) {
    const best = p.matches[0];
    const tag = p.isReferenced ? "↳ ref " : "      ";
    const sub = p.subtasks?.created ?? 0;
    console.log(
      `  ${tag}@${p.post.handle}/${p.post.statusId}  ${p.outcome}${p.reason ? ` (${p.reason})` : ""}  best=${best ? best.rawScore.toFixed(3) + "/" + best.score100 : "—"}  recs=${p.recommendations.length} subtasks=${sub}`,
    );
  }
  console.log("");
}

// ── tiny arg parser ────────────────────────────────────────────────────────
type Flags = Record<string, string | boolean | undefined>;
function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function loadEnv(): void {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(join(PACKAGE_ROOT, ".env"));
  } catch {
    /* no .env — fine */
  }
}

function printHelp(): void {
  console.log(`
kestrel — X Engagement Reply Agent

Usage:
  x-engagement-agent <command> [flags]

Commands:
  run         Run one polling pass.
  loop        Run continuously on the configured schedule.
  config      Print the resolved code-managed configuration and exit.
  help        Show this help.

Flags (run / loop):
  --dry-run            Match + draft, but create no Asana tasks and persist no state.
  --author <handle>    Restrict to a single watched author (handle or name).
  --force              Run even if settings.paused is true.
  --batch-size <n>     Override authors processed this run.
  --max-posts <n>      Override max posts fetched per author.
  --top-k <n>          Override article matches requested per post.
  --report-to <url>    POST the run summary to an Agent Network Platform.
  --interval <min>     (loop) Override poll interval.

Examples:
  npm start -- run --dry-run --author balajis
  npm start -- run
  npm start -- config
`);
}
