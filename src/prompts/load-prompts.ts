import * as fs from "node:fs";
import * as path from "node:path";

export type ReplyPromptSlot = {
  promptIndex: number;
  promptLabel: string;
  fileName: string;
  content: string;
  /**
   * True unless the file contains a literal "endsWithQuestion: false" line,
   * which is stripped from the returned content. Reply drafting (Phase 4)
   * must end each draft in a question except for slots that opt out this
   * way, per the assignment's "unless a prompt file explicitly overrides
   * that behavior" acceptance criterion.
   */
  endsWithQuestion: boolean;
};

export type PromptSet = {
  systemPrompt: string;
  constraints: string;
  replySlots: ReplyPromptSlot[];
};

const REPLY_FILENAME_PATTERN = /^(\d+)-([a-z0-9-]+)\.md$/i;
const ENDS_WITH_QUESTION_OVERRIDE_PATTERN = /^endsWithQuestion:\s*false\s*$/im;
const HEADING_PATTERN = /^#\s+(.+?)\s*$/m;

/**
 * Loads prompts/system.md, prompts/constraints.md, and every
 * prompts/replies/NN-slug.md file, sorted by numeric prefix. Throws with a
 * specific, actionable message on any missing file, empty content, malformed
 * filename, or duplicate numeric prefix -- there is no hot-reload, so a bad
 * prompt tree should fail fast at deploy/test time rather than silently
 * shipping a broken slot.
 */
export function loadPromptSet(promptsDir = path.join(process.cwd(), "prompts")): PromptSet {
  const systemPrompt = readRequiredTrimmed(path.join(promptsDir, "system.md"), "system prompt");
  const constraints = readRequiredTrimmed(
    path.join(promptsDir, "constraints.md"),
    "response constraints",
  );
  const replySlots = loadReplySlots(path.join(promptsDir, "replies"));
  return { systemPrompt, constraints, replySlots };
}

function readRequiredTrimmed(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required ${label} file: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) {
    throw new Error(`Required ${label} file is empty: ${filePath}`);
  }
  return content;
}

function loadReplySlots(repliesDir: string): ReplyPromptSlot[] {
  if (!fs.existsSync(repliesDir)) {
    throw new Error(`Missing required reply-prompts directory: ${repliesDir}`);
  }

  const fileNames = fs.readdirSync(repliesDir).filter((name) => name.toLowerCase().endsWith(".md"));

  if (fileNames.length === 0) {
    throw new Error(`No reply prompt files found in ${repliesDir}`);
  }

  const parsedNames = fileNames.map((fileName) => {
    const match = REPLY_FILENAME_PATTERN.exec(fileName);
    if (!match) {
      throw new Error(
        `Reply prompt file "${fileName}" in ${repliesDir} must match "NN-slug.md" ` +
          `(e.g. "01-recommend-and-draft.md")`,
      );
    }
    return { fileName, prefix: Number.parseInt(match[1], 10), slug: match[2] };
  });

  const seenPrefixes = new Map<number, string>();
  for (const { prefix, fileName } of parsedNames) {
    const existing = seenPrefixes.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate reply-prompt numeric prefix ${String(prefix).padStart(2, "0")} in ${repliesDir}: ` +
          `"${existing}" and "${fileName}"`,
      );
    }
    seenPrefixes.set(prefix, fileName);
  }

  parsedNames.sort((a, b) => a.prefix - b.prefix);

  return parsedNames.map(({ fileName, slug }, index) => {
    const filePath = path.join(repliesDir, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    const endsWithQuestion = !ENDS_WITH_QUESTION_OVERRIDE_PATTERN.test(raw);
    const content = raw.replace(ENDS_WITH_QUESTION_OVERRIDE_PATTERN, "").trim();
    if (!content) {
      throw new Error(`Reply prompt file is empty after removing overrides: ${filePath}`);
    }
    const headingMatch = HEADING_PATTERN.exec(content);
    const promptLabel = headingMatch ? headingMatch[1].trim() : titleCaseSlug(slug);
    return {
      promptIndex: index + 1,
      promptLabel,
      fileName,
      content,
      endsWithQuestion,
    };
  });
}

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
