import { describe, expect, it, vi } from "vitest";
import { createAsanaClient } from "./client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("createAsanaClient", () => {
  describe("createTask", () => {
    it("posts to /tasks and returns the created task", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { gid: "1", permalink_url: "https://app.asana.com/1" } }),
        );
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      const result = await client.createTask({ name: "Draft response: x" });

      expect(result).toEqual({ gid: "1", permalinkUrl: "https://app.asana.com/1" });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("/tasks?opt_fields=gid,permalink_url");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe("Bearer token");
      expect(JSON.parse(init.body)).toEqual({ data: { name: "Draft response: x" } });
    });

    it("throws a descriptive error on a non-2xx response", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ errors: [{ message: "bad" }] }, 400));
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      await expect(client.createTask({})).rejects.toThrow(/HTTP 400/);
    });

    it("rejects a response that does not match the expected shape", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      await expect(client.createTask({})).rejects.toThrow(/did not match the expected shape/);
    });
  });

  describe("addTaskToSection", () => {
    it("posts to /sections/:gid/addTask with the task gid", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      await client.addTaskToSection("task-1", "section-1");

      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("/sections/section-1/addTask");
      expect(JSON.parse(init.body)).toEqual({ data: { task: "task-1" } });
    });
  });

  describe("createSubtask", () => {
    it("posts to /tasks/:gid/subtasks and returns the created subtask", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { gid: "2", name: "Approve X Reply", permalink_url: "u" } }),
        );
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      const result = await client.createSubtask("parent-1", { name: "Approve X Reply" });

      expect(result).toEqual({ gid: "2", permalinkUrl: "u" });
      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("/tasks/parent-1/subtasks?opt_fields=gid,name,permalink_url");
    });
  });

  describe("listProjectTasks", () => {
    it("lists tasks with pagination fields and returns nextOffset", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ gid: "1", name: "Task 1", notes: "notes" }],
          next_page: { offset: "abc" },
        }),
      );
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      const result = await client.listProjectTasks({ projectGid: "proj-1", limit: 100 });

      expect(result.tasks).toEqual([{ gid: "1", name: "Task 1", notes: "notes" }]);
      expect(result.nextOffset).toBe("abc");
      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("/projects/proj-1/tasks?limit=100");
    });

    it("passes the offset param when provided", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      await client.listProjectTasks({ projectGid: "proj-1", limit: 100, offset: "xyz" });

      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("offset=xyz");
    });

    it("defaults missing name/notes to empty strings", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ gid: "1" }] }));
      const client = createAsanaClient({ accessToken: "token", fetchImpl });

      const result = await client.listProjectTasks({ projectGid: "proj-1", limit: 100 });

      expect(result.tasks).toEqual([{ gid: "1", name: "", notes: "" }]);
    });
  });
});
