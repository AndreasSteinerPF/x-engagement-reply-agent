import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStateStore } from "./file-state-store";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-state-store-test-"));
  filePath = join(dir, "state.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFileStateStore", () => {
  it("returns null for a cursor that has never been set, without creating the file", async () => {
    const store = createFileStateStore(filePath);
    await expect(store.getCursor("exampleauthor")).resolves.toBeNull();
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("persists a cursor across separate store instances (simulating separate process runs)", async () => {
    await createFileStateStore(filePath).setCursor("exampleauthor", "1000");

    const secondInstance = createFileStateStore(filePath);
    await expect(secondInstance.getCursor("exampleauthor")).resolves.toBe("1000");
  });

  it("normalizes handles the same way the DynamoDB-backed cursor store does (case, leading @)", async () => {
    const store = createFileStateStore(filePath);
    await store.setCursor("@ExampleAuthor", "2000");

    await expect(store.getCursor("exampleauthor")).resolves.toBe("2000");
    await expect(store.getCursor(" @EXAMPLEAUTHOR ")).resolves.toBe("2000");
  });

  it("tracks dedupe state per (sourceUri, statusId) pair, persisted across instances", async () => {
    const params = {
      sourceUri: "https://x.com/exampleauthor/status/123",
      statusId: "123",
      outcome: "tasked" as const,
      asanaTaskGid: "task-1",
    };
    await createFileStateStore(filePath).markProcessed(params);

    const secondInstance = createFileStateStore(filePath);
    await expect(secondInstance.hasProcessed(params.sourceUri, params.statusId)).resolves.toBe(
      true,
    );
    await expect(secondInstance.hasProcessed(params.sourceUri, "999")).resolves.toBe(false);
  });

  it("keeps cursors and dedupe entries for different handles/posts independent", async () => {
    const store = createFileStateStore(filePath);
    await store.setCursor("author-a", "111");
    await store.setCursor("author-b", "222");
    await store.markProcessed({ sourceUri: "uri-a", statusId: "1", outcome: "tasked" });

    await expect(store.getCursor("author-a")).resolves.toBe("111");
    await expect(store.getCursor("author-b")).resolves.toBe("222");
    await expect(store.hasProcessed("uri-a", "1")).resolves.toBe(true);
    await expect(store.hasProcessed("uri-b", "1")).resolves.toBe(false);
  });

  it("writes human-readable JSON to disk", async () => {
    const store = createFileStateStore(filePath);
    await store.setCursor("exampleauthor", "1000");

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { cursors: Record<string, string> };
    expect(parsed.cursors.exampleauthor).toBe("1000");
  });
});
