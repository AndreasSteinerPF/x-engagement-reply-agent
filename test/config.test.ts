import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadReplyPrompts, parseConstraints } from "../src/config/load.js";
import { MonitorSettingsSchema } from "../src/config/schema.js";

describe("loadReplyPrompts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "x-prompts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a minimal prompt file with optional frontmatter. */
  async function writePrompt(name: string, body: string, frontmatter?: string) {
    const content = frontmatter ? `---\n${frontmatter}\n---\n${body}\n` : `${body}\n`;
    await writeFile(join(dir, name), content, "utf8");
  }

  it("loads 5 configured slots with 1-based indexing; ignores .md.disabled and empty .md", async () => {
    await writePrompt("01-recommend.md", "Recommend the article and draft a reply.", 'label: "Recommend"');
    await writePrompt("02-agree.md", "Agree and extend the point.");
    await writePrompt("03-counter.md", "Respectfully counter the claim.");
    await writePrompt("04-example.md", "Give a concrete example.");
    await writePrompt("05-thesis.md", "State the sharpest thesis.");
    // Must be IGNORED (does not end with .md):
    await writePrompt("06-cta.md.disabled", "Call to action.");
    // Empty body -> unconfigured slot, must be SKIPPED:
    await writePrompt("07-empty.md", "");

    const prompts = await loadReplyPrompts(dir);

    expect(prompts).toHaveLength(5);
    expect(prompts.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
    expect(prompts[0]!.label).toBe("Recommend");
    expect(prompts.map((p) => p.file)).not.toContain("06-cta.md.disabled");
    expect(prompts.map((p) => p.file)).not.toContain("07-empty.md");
  });

  it("adding a 6th prompt file yields 6 slots (file change == config change)", async () => {
    for (let n = 1; n <= 6; n++) {
      await writePrompt(`0${n}-prompt.md`, `Prompt body number ${n}.`);
    }
    const prompts = await loadReplyPrompts(dir);
    expect(prompts).toHaveLength(6);
    expect(prompts.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses frontmatter requireQuestion:false (defaults to true otherwise)", async () => {
    await writePrompt("01-default.md", "Default prompt.");
    await writePrompt("02-cta.md", "Call to action prompt.", "requireQuestion: false");
    const prompts = await loadReplyPrompts(dir);
    expect(prompts[0]!.requireQuestion).toBe(true);
    expect(prompts[1]!.requireQuestion).toBe(false);
  });

  it("returns [] for a non-existent directory", async () => {
    const prompts = await loadReplyPrompts(join(dir, "does-not-exist"));
    expect(prompts).toEqual([]);
  });
});

describe("parseConstraints", () => {
  it("extracts only bullet lines, trimmed", () => {
    const md = [
      "# Global response constraints",
      "",
      "Some intro prose that is not a bullet.",
      "- Maximum of 280 characters.",
      "* Use short, simple sentences.  ",
      "   - Indented bullet kept.",
      "not a bullet",
    ].join("\n");
    expect(parseConstraints(md)).toEqual([
      "Maximum of 280 characters.",
      "Use short, simple sentences.",
      "Indented bullet kept.",
    ]);
  });

  it("returns [] when there are no bullets", () => {
    expect(parseConstraints("just prose\nmore prose")).toEqual([]);
  });
});

describe("MonitorSettingsSchema clamps", () => {
  it("clamps pollIntervalMinutes 9999 -> 1440", () => {
    const s = MonitorSettingsSchema.parse({ pollIntervalMinutes: 9999 });
    expect(s.pollIntervalMinutes).toBe(1440);
  });

  it("clamps articleSimilarityThreshold 5 -> 1", () => {
    const s = MonitorSettingsSchema.parse({ articleSimilarityThreshold: 5 });
    expect(s.articleSimilarityThreshold).toBe(1);
  });

  it("clamps low and rounds: pollIntervalMinutes 0 -> 1, defaultTopK 50 -> 20", () => {
    const s = MonitorSettingsSchema.parse({ pollIntervalMinutes: 0, defaultTopK: 50 });
    expect(s.pollIntervalMinutes).toBe(1);
    expect(s.defaultTopK).toBe(20);
  });

  it("applies defaults when fields are omitted", () => {
    const s = MonitorSettingsSchema.parse({});
    expect(s.pollIntervalMinutes).toBe(2);
    expect(s.articleSimilarityThreshold).toBe(0.7);
    expect(s.excludeAuthors).toEqual(["soofisafavi", "ssafavi"]);
  });
});
