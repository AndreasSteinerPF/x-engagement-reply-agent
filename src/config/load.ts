import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "@agent-network/contract";
import {
  MonitorSettingsSchema,
  WatchlistSchema,
  ReplyPromptFrontmatterSchema,
  type AgentConfig,
  type ReplyPrompt,
} from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root = two levels up from src/config. */
export const PACKAGE_ROOT = resolve(HERE, "..", "..");

export interface LoadConfigOptions {
  /** Root directory containing config/ and prompts/. Defaults to the package root. */
  rootDir?: string;
}

/**
 * Load all version-controlled configuration: settings, watchlist, the system
 * prompt, global response constraints, and one reply prompt per file.
 *
 * The whole point of the agent is that this is the *only* source of operational
 * behaviour — no admin UI, no database settings. Adding/removing/reordering a
 * reply prompt is a file change, nothing else.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AgentConfig> {
  const root = opts.rootDir ?? PACKAGE_ROOT;
  const paths = {
    settings: join(root, "config", "settings.yaml"),
    watchlist: join(root, "config", "watchlist.yaml"),
    systemPrompt: join(root, "prompts", "system.md"),
    constraints: join(root, "prompts", "constraints.md"),
    replyPromptsDir: join(root, "prompts", "replies"),
  };

  const settings = MonitorSettingsSchema.parse(await readYaml(paths.settings));
  const watchlist = WatchlistSchema.parse(await readYaml(paths.watchlist)).authors;
  const systemPrompt = (await readText(paths.systemPrompt)).trim();
  const responseConstraints = parseConstraints(await readText(paths.constraints));
  const replyPrompts = await loadReplyPrompts(paths.replyPromptsDir);

  if (replyPrompts.length === 0) {
    throw new Error(`No reply prompts found in ${paths.replyPromptsDir} (expected one or more *.md files).`);
  }

  return { settings, watchlist, systemPrompt, responseConstraints, replyPrompts, paths };
}

/** Load reply prompts: every `*.md` in `prompts/replies`, sorted by filename. */
export async function loadReplyPrompts(dir: string): Promise<ReplyPrompt[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "en"));

  const prompts: ReplyPrompt[] = [];
  let index = 0;
  for (const file of files) {
    const raw = await readText(join(dir, file));
    const { data, body } = splitFrontmatter(raw);
    const fm = ReplyPromptFrontmatterSchema.parse(data ?? {});
    const text = stripLeadingHeading(body).trim();
    if (!text) continue; // empty file = unconfigured slot, skip
    index += 1;
    prompts.push({
      index,
      label: fm.label ?? labelFromFilename(file),
      text,
      requireQuestion: fm.requireQuestion,
      file,
    });
  }
  return prompts;
}

/** Parse `constraints.md` bullet lines into the response-constraints array. */
export function parseConstraints(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map((x) => x.trim());
}

function labelFromFilename(file: string): string {
  return file
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]?/, "") // drop leading order prefix like "02-"
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function stripLeadingHeading(body: string): string {
  return body.replace(/^\s*#{1,6}\s+.*\r?\n/, "");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

async function readYaml(path: string): Promise<unknown> {
  const text = await readText(path);
  return parseYaml(text);
}
