import { z } from "zod";

/** Clamp helper used to keep settings within the same bounds as the reference pipeline. */
const clampedInt = (min: number, max: number, fallback: number) =>
  z.coerce
    .number()
    .default(fallback)
    .transform((n) => Math.min(max, Math.max(min, Math.round(n))));

const clampedFloat = (min: number, max: number, fallback: number) =>
  z.coerce
    .number()
    .default(fallback)
    .transform((n) => Math.min(max, Math.max(min, n)));

/**
 * Automation settings — the code-managed equivalent of the reference
 * `MonitorAutomationSettings` (investors-mcp `automation_settings` row).
 * Loaded from `config/settings.yaml`; bounds mirror `loadMonitorSettings()`.
 */
export const MonitorSettingsSchema = z.object({
  /** Stop the pipeline without removing it. */
  paused: z.coerce.boolean().default(false),
  /** Minimum minutes between scheduled runs. Clamp [1, 1440]. */
  pollIntervalMinutes: clampedInt(1, 1440, 2),
  /** Authors processed per run (cursor-rotated). Clamp [1, 20]. */
  defaultBatchSize: clampedInt(1, 20, 5),
  /** Max posts fetched per author per run. Clamp [1, 100]. */
  defaultMaxPostsPerAuthor: clampedInt(1, 100, 20),
  /** Number of article matches to request from the MCP. Clamp [1, 20]. */
  defaultTopK: clampedInt(1, 20, 6),
  /**
   * Parent-task gate on best-match raw similarity. 0 = always allow (if other
   * checks pass). Clamp [0, 1].
   */
  asanaTaskSimilarityThreshold: clampedFloat(0, 1, 0),
  /**
   * Per-article recommendation/subtask gate on raw similarity. Clamp [0, 1].
   */
  articleSimilarityThreshold: clampedFloat(0, 1, 0.7),
  /**
   * Model used for reply drafting. When no provider credentials are present the
   * agent falls back to the deterministic offline generator regardless of this
   * value (see adapters/llm).
   */
  modelId: z.string().default("openai/gpt-4.1-mini"),
  /** Authors (normalized) whose own posts are never tasked (e.g. the corpus author). */
  excludeAuthors: z.array(z.string()).default(["soofisafavi", "ssafavi"]),
});
export type MonitorSettings = z.infer<typeof MonitorSettingsSchema>;

/** A single watched author entry in `config/watchlist.yaml`. */
export const WatchAuthorSchema = z.object({
  author: z.string(),
  handle: z.string().transform((h) => h.replace(/^@/, "")),
  company: z.string().default(""),
  aliases: z
    .object({
      handles: z.array(z.string()).default([]),
      authors: z.array(z.string()).default([]),
    })
    .default({ handles: [], authors: [] }),
  active: z.coerce.boolean().default(true),
});

export const WatchlistSchema = z.object({
  authors: z.array(WatchAuthorSchema).default([]),
});
export type WatchlistFile = z.infer<typeof WatchlistSchema>;

/** Frontmatter recognised on a reply-prompt markdown file. */
export const ReplyPromptFrontmatterSchema = z.object({
  label: z.string().optional(),
  /**
   * Whether the generated reply must end with a thought-provoking question.
   * Defaults to true; a prompt file sets `requireQuestion: false` to override.
   */
  requireQuestion: z.coerce.boolean().default(true),
});
export type ReplyPromptFrontmatter = z.infer<typeof ReplyPromptFrontmatterSchema>;

/** A loaded reply prompt slot. */
export interface ReplyPrompt {
  /** 1-based slot index, derived from the sorted file order. */
  index: number;
  /** Display label (frontmatter `label`, else derived from filename). */
  label: string;
  /** The prompt instruction text (markdown body). */
  text: string;
  /** Whether the reply must end with a question. */
  requireQuestion: boolean;
  /** Source filename, for traceability. */
  file: string;
}

/** The fully resolved, code-managed configuration the pipeline runs on. */
export interface AgentConfig {
  settings: MonitorSettings;
  watchlist: ReturnType<typeof WatchlistSchema.parse>["authors"];
  systemPrompt: string;
  responseConstraints: string[];
  replyPrompts: ReplyPrompt[];
  /** Absolute paths used, for run-summary provenance. */
  paths: {
    settings: string;
    watchlist: string;
    systemPrompt: string;
    constraints: string;
    replyPromptsDir: string;
  };
}
