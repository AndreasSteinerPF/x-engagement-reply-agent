import { describe, expect, it, vi } from "vitest";
import type { AsanaClient } from "./client";
import { createAsanaDedupeCache } from "./dedupe";

function fakeAsanaClient(overrides: Partial<AsanaClient> = {}): AsanaClient {
  return {
    createTask: vi.fn(),
    addTaskToSection: vi.fn(),
    createSubtask: vi.fn(),
    listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    ...overrides,
  };
}

describe("createAsanaDedupeCache", () => {
  it("returns null when nothing matches", async () => {
    const asanaClient = fakeAsanaClient({
      listProjectTasks: vi
        .fn()
        .mockResolvedValue({ tasks: [{ gid: "1", name: "other", notes: "" }] }),
    });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "https://x.com/a/status/1",
      statusId: "1",
    });

    expect(result).toBeNull();
  });

  it("finds an existing task by sourceUri appearing in the task name", async () => {
    const asanaClient = fakeAsanaClient({
      listProjectTasks: vi.fn().mockResolvedValue({
        tasks: [
          { gid: "1", name: "Draft response: someone - https://x.com/a/status/1", notes: "" },
        ],
      }),
    });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "https://x.com/a/status/1",
      statusId: "1",
    });

    expect(result?.gid).toBe("1");
  });

  it("finds an existing task by status id appearing in the notes", async () => {
    const asanaClient = fakeAsanaClient({
      listProjectTasks: vi.fn().mockResolvedValue({
        tasks: [{ gid: "1", name: "Draft response", notes: "Source: /status/999" }],
      }),
    });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "https://x.com/a/status/different",
      statusId: "999",
    });

    expect(result?.gid).toBe("1");
  });

  it("matches case-insensitively", async () => {
    const asanaClient = fakeAsanaClient({
      listProjectTasks: vi
        .fn()
        .mockResolvedValue({ tasks: [{ gid: "1", name: "HTTPS://X.COM/A/STATUS/1", notes: "" }] }),
    });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "https://x.com/a/status/1",
      statusId: "1",
    });

    expect(result?.gid).toBe("1");
  });

  it("paginates until nextOffset is exhausted or maxScanTasks is reached", async () => {
    const listProjectTasks = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [{ gid: "1", name: "a", notes: "" }], nextOffset: "page-2" })
      .mockResolvedValueOnce({
        tasks: [{ gid: "2", name: "https://x.com/a/status/1", notes: "" }],
      });
    const asanaClient = fakeAsanaClient({ listProjectTasks });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "https://x.com/a/status/1",
      statusId: "1",
    });

    expect(result?.gid).toBe("2");
    expect(listProjectTasks).toHaveBeenCalledTimes(2);
    expect(listProjectTasks.mock.calls[1][0].offset).toBe("page-2");
  });

  it("caches the task list per project within the TTL window", async () => {
    const listProjectTasks = vi.fn().mockResolvedValue({ tasks: [] });
    const asanaClient = fakeAsanaClient({ listProjectTasks });
    const cache = createAsanaDedupeCache({ asanaClient, cacheTtlMs: 60_000 });

    await cache.findExistingTaskForPost({ projectGid: "proj-1", sourceUri: "a", statusId: "1" });
    await cache.findExistingTaskForPost({ projectGid: "proj-1", sourceUri: "b", statusId: "2" });

    expect(listProjectTasks).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    const listProjectTasks = vi.fn().mockResolvedValue({ tasks: [] });
    const asanaClient = fakeAsanaClient({ listProjectTasks });
    const cache = createAsanaDedupeCache({ asanaClient, cacheTtlMs: 0 });

    await cache.findExistingTaskForPost({ projectGid: "proj-1", sourceUri: "a", statusId: "1" });
    await cache.findExistingTaskForPost({ projectGid: "proj-1", sourceUri: "a", statusId: "1" });

    expect(listProjectTasks).toHaveBeenCalledTimes(2);
  });

  it("returns null without calling the client when sourceUri and statusId are both empty", async () => {
    const listProjectTasks = vi.fn();
    const asanaClient = fakeAsanaClient({ listProjectTasks });
    const cache = createAsanaDedupeCache({ asanaClient });

    const result = await cache.findExistingTaskForPost({
      projectGid: "proj-1",
      sourceUri: "",
      statusId: "",
    });

    expect(result).toBeNull();
    expect(listProjectTasks).not.toHaveBeenCalled();
  });
});
