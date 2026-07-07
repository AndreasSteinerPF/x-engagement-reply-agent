import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSummary } from "@agent-network/contract";
import { loadConfig } from "../config/load.js";
import type { AgentConfig } from "../config/schema.js";
import { createXClient } from "../adapters/x/index.js";
import { createReplyGenerator } from "../adapters/llm/index.js";
import { createAsanaClient } from "../adapters/asana/index.js";
import { composeIntentLink, parentTaskName, subtaskName } from "../adapters/asana/notes.js";
import { McpArticleMatcher } from "../similarity.js";
import { isExcludedAuthor } from "../pipeline/thresholds.js";
import { McpClient, DEFAULT_MCP_URL } from "../mcp/client.js";
import { MemoryStateStore } from "../state/file-store.js";
import { MemoryTraceSink, type TraceRecord } from "../obs/trace.js";
import { Logger } from "../obs/logger.js";
import { runMonitor, type RunArtifact, type RunDeps } from "../pipeline/run.js";

/**
 * Serverless composition root for the agent's hosted web runtime. It runs the
 * exact same {@link runMonitor} pipeline the CLI runs, but wired with
 * filesystem-free sinks (in-memory state + traces) so it works on a serverless
 * platform, and with the credential-free adapters (fixtures + the REAL hosted
 * MCP + deterministic drafting) so it is exercisable in a browser with no setup.
 *
 * All config and prompts are read from `process.cwd()` — the deploy includes
 * `config/`, `prompts/`, and `fixtures/` at the project root (see next.config).
 */

export interface AsanaSubtaskView {
  name: string;
  promptLabel: string;
  articleTitle: string;
  score100: number;
  draft: string;
  draftChars: number;
  composeUrl: string;
}

export interface AsanaParentView {
  name: string;
  statusId: string;
  thresholdMet: boolean;
  topScore100: number;
  /** Threshold-based assignee rule the live Asana adapter would apply. */
  assignee: string;
  /** The live adapter sets a same-day due date when the threshold assignee rule applies. */
  dueToday: boolean;
  subtasks: AsanaSubtaskView[];
}

export interface WebRunResult {
  summary: RunSummary;
  artifact: RunArtifact;
  traces: TraceRecord[];
  asana: AsanaParentView[];
  modes: { x: string; llm: string; asana: string };
  mcpEndpoint: string;
}

export interface WebRunOptions {
  dryRun?: boolean;
  /** Restrict to a single watched author (handle or name). */
  author?: string;
  /** Max posts fetched per author (kept small so the run stays within timeout). */
  maxPostsPerAuthor?: number;
}

export async function runWeb(opts: WebRunOptions = {}): Promise<WebRunResult> {
  const root = process.cwd();
  const config = await loadConfig({ rootDir: root });

  // Default to the first active, non-excluded author so a no-arg run (e.g. the
  // platform's "Run agent" button) lands on an author that actually produces
  // recommendations — not the excluded corpus author at the head of the list.
  const author =
    opts.author ??
    config.watchlist.find((a) => a.active && !isExcludedAuthor(a.handle || a.author, config.settings.excludeAuthors))?.handle;

  const runId = `web-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = join(tmpdir(), "kestrel-web", runId);

  const logger = new Logger({ context: { agent: "kestrel", surface: "web" } });
  const { client: xClient, mode: xMode } = createXClient({ fixturesDir: join(root, "fixtures", "posts") });
  const { generator, mode: llmMode } = createReplyGenerator(config.settings.modelId);
  const { client: asana, mode: asanaMode } = createAsanaClient({
    outDir,
    thresholds: {
      asanaTaskSimilarityThreshold: config.settings.asanaTaskSimilarityThreshold,
      articleSimilarityThreshold: config.settings.articleSimilarityThreshold,
    },
  });
  const trace = new MemoryTraceSink(runId);

  const deps: RunDeps = {
    config,
    xClient,
    matcher: new McpArticleMatcher(new McpClient()),
    generator,
    asana,
    state: new MemoryStateStore(),
    trace,
    logger,
    outDir,
    modes: {
      x: xMode,
      llm: llmMode === "offline" ? `offline (${generator.model})` : `${generator.provider}/${generator.model}`,
      asana: asanaMode,
    },
  };

  const { summary, artifact } = await runMonitor(deps, {
    runId,
    dryRun: Boolean(opts.dryRun),
    authorFilter: author,
    maxPostsPerAuthor: opts.maxPostsPerAuthor ?? 5,
    batchSize: 1,
    agentId: "kestrel",
  });

  return {
    summary,
    artifact,
    traces: trace.records,
    asana: buildAsanaView(artifact),
    modes: deps.modes,
    mcpEndpoint: process.env.MCP_URL ?? DEFAULT_MCP_URL,
  };
}

/**
 * Project the run artifact into the exact would-be Asana approval tasks (parent
 * + one subtask per article × prompt, each with its X compose-intent link). This
 * is what the live Asana adapter would POST — rendered for the reviewer instead.
 */
function buildAsanaView(artifact: RunArtifact): AsanaParentView[] {
  const parents: AsanaParentView[] = [];
  for (const rec of artifact.posts) {
    if (rec.recommendations.length === 0) continue;
    const watch = { author: rec.post.author, handle: rec.post.handle, company: "", aliases: { handles: [], authors: [] }, active: true };
    const subtasks: AsanaSubtaskView[] = [];
    for (const article of rec.recommendations) {
      for (const response of article.suggestedResponses) {
        subtasks.push({
          name: subtaskName(response.promptLabel, article.title),
          promptLabel: response.promptLabel,
          articleTitle: article.title,
          score100: article.score100,
          draft: response.text,
          draftChars: response.text.length,
          composeUrl: composeIntentLink(rec.post.statusId, response.text),
        });
      }
    }
    const thresholdMet = subtasks.length > 0;
    parents.push({
      name: parentTaskName(watch, rec.post),
      statusId: rec.post.statusId,
      thresholdMet,
      topScore100: rec.matches[0]?.score100 ?? 0,
      // Mirrors the Asana adapter: when the article threshold is met, the parent
      // routes to the threshold-rule assignee and is due today; otherwise it
      // goes to the default assignee with no due date.
      assignee: thresholdMet ? "threshold-rule assignee (ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID)" : "default assignee (ASANA_ASSIGNEE_GID)",
      dueToday: thresholdMet,
      subtasks,
    });
  }
  return parents;
}

export type { AgentConfig };
