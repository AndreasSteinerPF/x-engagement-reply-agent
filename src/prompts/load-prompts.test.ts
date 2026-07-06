import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPromptSet } from "./load-prompts";

let tmpDir: string;

function scaffold(options: {
  system?: string | null;
  constraints?: string | null;
  replies?: Record<string, string>;
  skipRepliesDir?: boolean;
}): string {
  const promptsDir = path.join(tmpDir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  if (options.system !== null) {
    fs.writeFileSync(
      path.join(promptsDir, "system.md"),
      options.system ?? "You are a helpful assistant.",
    );
  }
  if (options.constraints !== null) {
    fs.writeFileSync(
      path.join(promptsDir, "constraints.md"),
      options.constraints ?? "- Be concise.",
    );
  }

  if (!options.skipRepliesDir) {
    const repliesDir = path.join(promptsDir, "replies");
    fs.mkdirSync(repliesDir, { recursive: true });
    const replies = options.replies ?? {
      "01-recommend-and-draft.md": "# Prompt 1 — Recommend\n\nDraft a reply.",
    };
    for (const [fileName, content] of Object.entries(replies)) {
      fs.writeFileSync(path.join(repliesDir, fileName), content);
    }
  }

  return promptsDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPromptSet", () => {
  it("loads system prompt, constraints, and reply slots", () => {
    const promptsDir = scaffold({});
    const result = loadPromptSet(promptsDir);

    expect(result.systemPrompt).toBe("You are a helpful assistant.");
    expect(result.constraints).toBe("- Be concise.");
    expect(result.replySlots).toHaveLength(1);
  });

  it("sorts reply slots by numeric prefix and assigns sequential promptIndex", () => {
    const promptsDir = scaffold({
      replies: {
        "03-third.md": "# Prompt 3 — Third\n\nThird content.",
        "01-first.md": "# Prompt 1 — First\n\nFirst content.",
        "02-second.md": "# Prompt 2 — Second\n\nSecond content.",
      },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots.map((s) => s.fileName)).toEqual([
      "01-first.md",
      "02-second.md",
      "03-third.md",
    ]);
    expect(result.replySlots.map((s) => s.promptIndex)).toEqual([1, 2, 3]);
  });

  it("assigns sequential promptIndex even with gaps in the numeric prefixes", () => {
    const promptsDir = scaffold({
      replies: {
        "01-first.md": "# Prompt — First\n\nFirst content.",
        "04-second.md": "# Prompt — Second\n\nSecond content.",
      },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots.map((s) => s.promptIndex)).toEqual([1, 2]);
  });

  it("derives promptLabel from a leading heading", () => {
    const promptsDir = scaffold({
      replies: { "01-first.md": "# Prompt 1 — Recommend and draft\n\nBody." },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots[0].promptLabel).toBe("Prompt 1 — Recommend and draft");
  });

  it("falls back to a title-cased filename slug when there is no heading", () => {
    const promptsDir = scaffold({
      replies: { "01-agree-and-clarify.md": "Just body text, no heading." },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots[0].promptLabel).toBe("Agree And Clarify");
  });

  it("defaults endsWithQuestion to true", () => {
    const promptsDir = scaffold({
      replies: { "01-first.md": "# Prompt 1\n\nDraft a reply ending in a question." },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots[0].endsWithQuestion).toBe(true);
  });

  it("honors an endsWithQuestion: false override and strips the marker line", () => {
    const promptsDir = scaffold({
      replies: {
        "06-context-note.md":
          "endsWithQuestion: false\n\n# Prompt 6 — Context note\n\nState a fact, no question.",
      },
    });

    const result = loadPromptSet(promptsDir);
    expect(result.replySlots[0].endsWithQuestion).toBe(false);
    expect(result.replySlots[0].content).not.toMatch(/endsWithQuestion/);
    expect(result.replySlots[0].content.startsWith("# Prompt 6")).toBe(true);
  });

  it("throws on a duplicate numeric prefix", () => {
    const promptsDir = scaffold({
      replies: {
        "01-first.md": "# Prompt — First\n\nBody.",
        "01-first-again.md": "# Prompt — First again\n\nBody.",
      },
    });

    expect(() => loadPromptSet(promptsDir)).toThrow(/Duplicate reply-prompt numeric prefix/);
  });

  it("throws on a malformed reply filename", () => {
    const promptsDir = scaffold({
      replies: { "not-numbered.md": "Body." },
    });

    expect(() => loadPromptSet(promptsDir)).toThrow(/must match "NN-slug\.md"/);
  });

  it("throws when system.md is missing", () => {
    const promptsDir = scaffold({ system: null });
    expect(() => loadPromptSet(promptsDir)).toThrow(/Missing required system prompt file/);
  });

  it("throws when constraints.md is empty", () => {
    const promptsDir = scaffold({ constraints: "   \n  " });
    expect(() => loadPromptSet(promptsDir)).toThrow(/Required response constraints file is empty/);
  });

  it("throws when the replies directory is missing", () => {
    const promptsDir = scaffold({ skipRepliesDir: true });
    expect(() => loadPromptSet(promptsDir)).toThrow(/Missing required reply-prompts directory/);
  });

  it("throws when the replies directory is empty", () => {
    const promptsDir = scaffold({ replies: {} });
    expect(() => loadPromptSet(promptsDir)).toThrow(/No reply prompt files found/);
  });
});

describe("loadPromptSet (real project prompts/)", () => {
  it("loads at least six reply slots without throwing", () => {
    const result = loadPromptSet();
    expect(result.replySlots.length).toBeGreaterThanOrEqual(6);
  });

  it("has exactly one slot with endsWithQuestion overridden to false", () => {
    const result = loadPromptSet();
    const overridden = result.replySlots.filter((slot) => !slot.endsWithQuestion);
    expect(overridden).toHaveLength(1);
    expect(overridden[0].fileName).toBe("06-context-note.md");
  });
});
