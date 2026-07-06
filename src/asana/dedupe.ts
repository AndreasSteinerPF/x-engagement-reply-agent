import type { AsanaClient } from "./client";
import type { AsanaTaskSummary } from "./types";

export type FindExistingTaskParams = {
  projectGid: string;
  sourceUri: string;
  statusId: string;
};

export type AsanaDedupeCache = {
  findExistingTaskForPost: (params: FindExistingTaskParams) => Promise<AsanaTaskSummary | null>;
};

export type CreateAsanaDedupeCacheOptions = {
  asanaClient: AsanaClient;
  maxScanTasks?: number;
  cacheTtlMs?: number;
  pageSize?: number;
};

const DEFAULT_MAX_SCAN_TASKS = 300;
const DEFAULT_CACHE_TTL_MS = 20_000;
const DEFAULT_PAGE_SIZE = 100;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Ported from investors-mcp's listRecentAsanaProjectTasks +
 * findExistingAsanaTaskForPost: a capped, paginated, time-cached scan of a
 * project's tasks, matching sourceUri/statusId as a case-insensitive
 * substring of each task's name+notes. Same pragmatic (not infinitely
 * scalable) approach the reference uses -- acceptable at demo scale, and
 * only a fallback: the DynamoDB dedupe store (Phase 2) is the fast path.
 */
export function createAsanaDedupeCache(options: CreateAsanaDedupeCacheOptions): AsanaDedupeCache {
  const { asanaClient } = options;
  const maxScanTasks = options.maxScanTasks ?? DEFAULT_MAX_SCAN_TASKS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, maxScanTasks, 100);

  const cacheByProject = new Map<string, { fetchedAtMs: number; tasks: AsanaTaskSummary[] }>();

  async function listRecentProjectTasks(projectGid: string): Promise<AsanaTaskSummary[]> {
    const nowMs = Date.now();
    const cached = cacheByProject.get(projectGid);
    if (cached && nowMs - cached.fetchedAtMs < cacheTtlMs) {
      return cached.tasks;
    }

    const tasks: AsanaTaskSummary[] = [];
    let offset: string | undefined;
    while (tasks.length < maxScanTasks) {
      const result = await asanaClient.listProjectTasks({ projectGid, limit: pageSize, offset });
      tasks.push(...result.tasks.slice(0, maxScanTasks - tasks.length));
      if (!result.nextOffset) break;
      offset = result.nextOffset;
    }

    cacheByProject.set(projectGid, { fetchedAtMs: nowMs, tasks });
    return tasks;
  }

  async function findExistingTaskForPost(
    params: FindExistingTaskParams,
  ): Promise<AsanaTaskSummary | null> {
    const sourceKey = normalizeWhitespace(params.sourceUri).toLowerCase();
    const statusNeedle = params.statusId
      ? `/status/${normalizeWhitespace(params.statusId)}`.toLowerCase()
      : "";
    if (!sourceKey && !statusNeedle) return null;

    const tasks = await listRecentProjectTasks(params.projectGid);
    for (const task of tasks) {
      const haystack = `${task.name}\n${task.notes}`.toLowerCase();
      if (sourceKey && haystack.includes(sourceKey)) return task;
      if (statusNeedle && haystack.includes(statusNeedle)) return task;
    }
    return null;
  }

  return { findExistingTaskForPost };
}
