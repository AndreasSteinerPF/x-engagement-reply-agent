import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWatchlist } from "./watchlist";

let tmpDir: string;

function writeWatchlist(yamlContent: string): string {
  const filePath = path.join(tmpDir, "watchlist.yaml");
  fs.writeFileSync(filePath, yamlContent, "utf8");
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchlist-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadWatchlist", () => {
  it("parses a valid watchlist", () => {
    const filePath = writeWatchlist(`
authors:
  - author: "Example Author"
    handle: "exampleauthor"
    company: "example-co"
    aliases:
      handles: []
      authors: []
    active: true
`);

    const result = loadWatchlist(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      author: "Example Author",
      handle: "exampleauthor",
      company: "example-co",
      active: true,
    });
  });

  it("defaults aliases when omitted", () => {
    const filePath = writeWatchlist(`
authors:
  - author: "Example Author"
    handle: "exampleauthor"
    company: "example-co"
    active: true
`);

    const result = loadWatchlist(filePath);
    expect(result[0].aliases).toEqual({ handles: [], authors: [] });
  });

  it("throws when the file is missing", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.yaml");
    expect(() => loadWatchlist(missingPath)).toThrow(/Missing watchlist config file/);
  });

  it("throws when the authors list is empty", () => {
    const filePath = writeWatchlist("authors: []\n");
    expect(() => loadWatchlist(filePath)).toThrow(/at least one author/);
  });

  it("throws when a required field is missing", () => {
    const filePath = writeWatchlist(`
authors:
  - handle: "exampleauthor"
    company: "example-co"
    active: true
`);
    expect(() => loadWatchlist(filePath)).toThrow(/Invalid watchlist config/);
  });

  it("throws when active is not a boolean", () => {
    const filePath = writeWatchlist(`
authors:
  - author: "Example Author"
    handle: "exampleauthor"
    company: "example-co"
    active: "yes"
`);
    expect(() => loadWatchlist(filePath)).toThrow(/Invalid watchlist config/);
  });

  it("throws on duplicate handles regardless of case or leading @", () => {
    const filePath = writeWatchlist(`
authors:
  - author: "Example Author"
    handle: "@ExampleAuthor"
    company: "example-co"
    active: true
  - author: "Someone Else"
    handle: "exampleauthor"
    company: "other-co"
    active: true
`);
    expect(() => loadWatchlist(filePath)).toThrow(/duplicate handle/);
  });
});

describe("loadWatchlist (real project config/watchlist.yaml)", () => {
  it("loads without throwing, catching drift between the real file and this schema", () => {
    expect(() => loadWatchlist()).not.toThrow();
  });
});
