import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const AliasesSchema = z
  .object({
    handles: z.array(z.string().min(1)).default([]),
    authors: z.array(z.string().min(1)).default([]),
  })
  .default({ handles: [], authors: [] });

const WatchedAuthorSchema = z.object({
  author: z.string().min(1, "author is required"),
  handle: z.string().min(1, "handle is required"),
  company: z.string().min(1, "company is required"),
  aliases: AliasesSchema,
  active: z.boolean(),
});

const WatchlistFileSchema = z.object({
  authors: z.array(WatchedAuthorSchema).min(1, "watchlist must contain at least one author"),
});

export type WatchedAuthor = z.infer<typeof WatchedAuthorSchema>;
export type WatchlistFile = z.infer<typeof WatchlistFileSchema>;

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Loads and validates config/watchlist.yaml. Throws with a clear, specific
 * message on any schema violation or duplicate handle rather than silently
 * dropping or coercing bad entries -- this config is code-reviewed, not
 * database-mutated, so a bad value should fail CI/deploy loudly.
 */
export function loadWatchlist(
  filePath = path.join(process.cwd(), "config", "watchlist.yaml"),
): WatchedAuthor[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing watchlist config file: ${filePath}`);
  }

  const raw = parseYaml(fs.readFileSync(filePath, "utf8"));
  const result = WatchlistFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid watchlist config at ${filePath}:\n${issues}`);
  }

  const seenHandles = new Map<string, string>();
  for (const entry of result.data.authors) {
    const normalized = normalizeHandle(entry.handle);
    const existing = seenHandles.get(normalized);
    if (existing) {
      throw new Error(
        `Invalid watchlist config at ${filePath}: duplicate handle "@${normalized}" ` +
          `(used by both "${existing}" and "${entry.author}")`,
      );
    }
    seenHandles.set(normalized, entry.author);
  }

  return result.data.authors;
}
