import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./settings";

let tmpDir: string;

const VALID_REQUIRED_FIELDS = `
pollIntervalMinutes: 2
defaultBatchSize: 5
defaultMaxPostsPerAuthor: 20
defaultTopK: 40
asanaTaskSimilarityThreshold: 0
articleSimilarityThreshold: 0.7
modelId: "anthropic.claude-3-5-haiku-20241022-v1:0"
`;

function overrideField(yamlContent: string, field: string, value: number): string {
  const pattern = new RegExp(`^${field}:.*$`, "m");
  return yamlContent.replace(pattern, `${field}: ${value}`);
}

function writeSettings(yamlContent: string): string {
  const filePath = path.join(tmpDir, "settings.yaml");
  fs.writeFileSync(filePath, yamlContent, "utf8");
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("parses valid settings and applies defaults for new fields", () => {
    const filePath = writeSettings(VALID_REQUIRED_FIELDS);
    const settings = loadSettings(filePath);

    expect(settings.pollIntervalMinutes).toBe(2);
    expect(settings.defaultTopK).toBe(40);
    expect(settings.modelId).toBe("anthropic.claude-3-5-haiku-20241022-v1:0");
    expect(settings.dedupeTtlDays).toBe(90);
    expect(settings.backfillHours).toBe(24);
    expect(settings.costCeilingUsdPerRun).toBe(5);
    expect(settings.excludedTaskAuthors).toEqual([]);
    expect(settings.maxReplyCharacters).toBe(280);
  });

  it("accepts explicit new-field overrides", () => {
    const filePath = writeSettings(
      `${VALID_REQUIRED_FIELDS}\ndedupeTtlDays: 30\nbackfillHours: 12\ncostCeilingUsdPerRun: 2.5\nexcludedTaskAuthors:\n  - "Soofi Safavi"\nmaxReplyCharacters: 240\n`,
    );
    const settings = loadSettings(filePath);

    expect(settings.dedupeTtlDays).toBe(30);
    expect(settings.backfillHours).toBe(12);
    expect(settings.costCeilingUsdPerRun).toBe(2.5);
    expect(settings.excludedTaskAuthors).toEqual(["Soofi Safavi"]);
    expect(settings.maxReplyCharacters).toBe(240);
  });

  it("throws when the file is missing", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.yaml");
    expect(() => loadSettings(missingPath)).toThrow(/Missing settings config file/);
  });

  describe("boundary values", () => {
    it.each([
      ["pollIntervalMinutes", 1],
      ["pollIntervalMinutes", 1440],
      ["defaultBatchSize", 1],
      ["defaultBatchSize", 20],
      ["defaultMaxPostsPerAuthor", 1],
      ["defaultMaxPostsPerAuthor", 100],
      ["defaultTopK", 1],
      ["defaultTopK", 100],
      ["asanaTaskSimilarityThreshold", 0],
      ["asanaTaskSimilarityThreshold", 1],
      ["articleSimilarityThreshold", 0],
      ["articleSimilarityThreshold", 1],
    ])("accepts %s at the boundary value %d", (field, value) => {
      const filePath = writeSettings(overrideField(VALID_REQUIRED_FIELDS, field, value));
      expect(() => loadSettings(filePath)).not.toThrow();
    });

    it.each([
      ["pollIntervalMinutes", 0],
      ["pollIntervalMinutes", 1441],
      ["defaultBatchSize", 0],
      ["defaultBatchSize", 21],
      ["defaultMaxPostsPerAuthor", 0],
      ["defaultMaxPostsPerAuthor", 101],
      ["defaultTopK", 0],
      ["defaultTopK", 101],
      ["asanaTaskSimilarityThreshold", -0.01],
      ["asanaTaskSimilarityThreshold", 1.01],
      ["articleSimilarityThreshold", -0.01],
      ["articleSimilarityThreshold", 1.01],
    ])("rejects %s just outside the boundary (%d)", (field, value) => {
      const filePath = writeSettings(overrideField(VALID_REQUIRED_FIELDS, field, value));
      expect(() => loadSettings(filePath)).toThrow(/Invalid settings config/);
    });
  });

  it("rejects a topK of 40 under the OLD legacy 1-20 cap (documents the widened bound)", () => {
    // defaultTopK: 40 is in VALID_REQUIRED_FIELDS above and must NOT throw --
    // this is the deliberate schema widening documented in docs/config-schema.md.
    const filePath = writeSettings(VALID_REQUIRED_FIELDS);
    expect(() => loadSettings(filePath)).not.toThrow();
  });

  it("throws when modelId is empty", () => {
    const filePath = writeSettings(VALID_REQUIRED_FIELDS.replace(/modelId:.*/, 'modelId: ""'));
    expect(() => loadSettings(filePath)).toThrow(/Invalid settings config/);
  });

  it("throws when a required field is missing entirely", () => {
    const filePath = writeSettings(VALID_REQUIRED_FIELDS.replace(/modelId:.*/, ""));
    expect(() => loadSettings(filePath)).toThrow(/Invalid settings config/);
  });

  it("rejects a non-positive costCeilingUsdPerRun", () => {
    const filePath = writeSettings(`${VALID_REQUIRED_FIELDS}\ncostCeilingUsdPerRun: 0\n`);
    expect(() => loadSettings(filePath)).toThrow(/Invalid settings config/);
  });
});

describe("loadSettings (real project config/settings.yaml)", () => {
  it("loads without throwing, catching drift between the real file and this schema", () => {
    expect(() => loadSettings()).not.toThrow();
  });

  it("excludes the corpus author from Asana tasking by default", () => {
    expect(loadSettings().excludedTaskAuthors).toContain("Soofi Safavi");
  });
});
