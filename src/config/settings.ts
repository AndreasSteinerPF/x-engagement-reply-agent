import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Bounds mostly carried over from the legacy investors-mcp
// lib/automation/monitor-settings.ts DB-backed schema, adapted from
// silent-clamp-on-write to throw-on-load (see loadSettings doc comment).
// defaultTopK is deliberately widened from the legacy 1-20 cap to 1-100
// because the required MCP integration example itself uses topK: 40.
const SettingsFileSchema = z.object({
  pollIntervalMinutes: z.number().int().min(1).max(1440),
  defaultBatchSize: z.number().int().min(1).max(20),
  defaultMaxPostsPerAuthor: z.number().int().min(1).max(100),
  defaultTopK: z.number().int().min(1).max(100),
  asanaTaskSimilarityThreshold: z.number().min(0).max(1),
  articleSimilarityThreshold: z.number().min(0).max(1),
  modelId: z.string().min(1, "modelId is required"),
  dedupeTtlDays: z.number().int().min(1).max(365).default(90),
  backfillHours: z.number().int().min(1).max(168).default(24),
  costCeilingUsdPerRun: z.number().positive().default(5),
  excludedTaskAuthors: z.array(z.string().min(1)).default([]),
  // Machine-readable mirror of the "Maximum of 280 characters" line in
  // prompts/constraints.md -- that file is prose for the LLM; this field is
  // what post-generation validation actually checks against (Phase 4).
  maxReplyCharacters: z.number().int().min(1).max(2000).default(280),
});

export type MonitorSettings = z.infer<typeof SettingsFileSchema>;

/**
 * Loads and validates config/settings.yaml. A bad or out-of-bounds value
 * throws immediately with the exact field and constraint violated, rather
 * than silently clamping like the legacy DB-backed settings did -- this
 * config is code-reviewed and redeployed, so bad values should fail
 * CI/deploy loudly instead of quietly coercing at runtime.
 */
export function loadSettings(
  filePath = path.join(process.cwd(), "config", "settings.yaml"),
): MonitorSettings {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing settings config file: ${filePath}`);
  }

  const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
  const result = SettingsFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid settings config at ${filePath}:\n${issues}`);
  }

  return result.data;
}
