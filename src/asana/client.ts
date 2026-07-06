import {
  AsanaListTasksResponseSchema,
  AsanaSubtaskCreateResponseSchema,
  AsanaTaskCreateResponseSchema,
  type AsanaTaskSummary,
} from "./types";

const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";

export type CreatedAsanaTask = {
  gid: string;
  permalinkUrl: string;
};

export type ListProjectTasksParams = {
  projectGid: string;
  limit: number;
  offset?: string;
};

export type ListProjectTasksResult = {
  tasks: AsanaTaskSummary[];
  nextOffset?: string;
};

export type AsanaClient = {
  createTask: (payload: Record<string, unknown>) => Promise<CreatedAsanaTask>;
  addTaskToSection: (taskGid: string, sectionGid: string) => Promise<void>;
  createSubtask: (
    parentTaskGid: string,
    payload: Record<string, unknown>,
  ) => Promise<CreatedAsanaTask>;
  listProjectTasks: (params: ListProjectTasksParams) => Promise<ListProjectTasksResult>;
};

export type AsanaClientOptions = {
  accessToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

/**
 * Thin REST client over the Asana API. No Chat SDK, no webhook -- this
 * agent only writes tasks and never listens for Asana events (see
 * CLAUDE.md). Every response is validated against a Zod schema before use
 * (see src/asana/types.ts), per the same "External System Response
 * Validation" discipline already applied to the X and MCP clients.
 */
export function createAsanaClient(options: AsanaClientOptions): AsanaClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? ASANA_API_BASE_URL;

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: Record<string, unknown> },
  ): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify({ data: init.body }) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Asana request failed: HTTP ${response.status} ${path} ${body.slice(0, 500)}`,
      );
    }

    return response.json();
  }

  async function createTask(payload: Record<string, unknown>): Promise<CreatedAsanaTask> {
    const raw = await request("/tasks?opt_fields=gid,permalink_url", {
      method: "POST",
      body: payload,
    });
    const parsed = AsanaTaskCreateResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Asana createTask response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return { gid: parsed.data.data.gid, permalinkUrl: parsed.data.data.permalink_url ?? "" };
  }

  async function addTaskToSection(taskGid: string, sectionGid: string): Promise<void> {
    await request(`/sections/${sectionGid}/addTask`, { method: "POST", body: { task: taskGid } });
  }

  async function createSubtask(
    parentTaskGid: string,
    payload: Record<string, unknown>,
  ): Promise<CreatedAsanaTask> {
    const raw = await request(
      `/tasks/${parentTaskGid}/subtasks?opt_fields=gid,name,permalink_url`,
      {
        method: "POST",
        body: payload,
      },
    );
    const parsed = AsanaSubtaskCreateResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Asana createSubtask response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return { gid: parsed.data.data.gid, permalinkUrl: parsed.data.data.permalink_url ?? "" };
  }

  async function listProjectTasks(params: ListProjectTasksParams): Promise<ListProjectTasksResult> {
    const query = new URLSearchParams({
      limit: String(params.limit),
      opt_fields: "gid,name,notes,permalink_url",
    });
    if (params.offset) query.set("offset", params.offset);

    const raw = await request(`/projects/${params.projectGid}/tasks?${query.toString()}`, {
      method: "GET",
    });
    const parsed = AsanaListTasksResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Asana listProjectTasks response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return { tasks: parsed.data.data, nextOffset: parsed.data.next_page?.offset };
  }

  return { createTask, addTaskToSection, createSubtask, listProjectTasks };
}
