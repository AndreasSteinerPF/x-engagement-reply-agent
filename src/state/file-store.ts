import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { MonitorState, StateStore, TrackedPost } from "../ports.js";

const DEFAULT_STATE: MonitorState = { cursor: 0, lastSeenStatusIdByHandle: {}, processedKeys: [] };

/**
 * File-backed {@link StateStore}: persists the monitor cursor, per-handle
 * last-seen ids, and processed-post dedupe keys to `<stateDir>/monitor-state.json`,
 * and appends an audit record per post to `<stateDir>/tracked-posts.jsonl`.
 *
 * This satisfies "persist runtime state externally" — the state survives process
 * restarts and lives on the deployment volume. A Postgres-backed implementation
 * of the same interface is the documented production swap (see docs/decisions.md
 * ADR-0004); nothing else in the agent changes.
 */
export class FileStateStore implements StateStore {
  private readonly statePath: string;
  private readonly trackedPath: string;

  constructor(private readonly stateDir: string) {
    this.statePath = join(stateDir, "monitor-state.json");
    this.trackedPath = join(stateDir, "tracked-posts.jsonl");
  }

  async loadState(): Promise<MonitorState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MonitorState>;
      return {
        cursor: parsed.cursor ?? 0,
        lastSeenStatusIdByHandle: parsed.lastSeenStatusIdByHandle ?? {},
        processedKeys: parsed.processedKeys ?? [],
      };
    } catch {
      return { ...DEFAULT_STATE, lastSeenStatusIdByHandle: {}, processedKeys: [] };
    }
  }

  async saveState(state: MonitorState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    // Atomic write: write to a temp file then rename.
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.statePath);
  }

  async recordPost(record: TrackedPost): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(this.trackedPath, JSON.stringify(record) + "\n", "utf8");
  }
}

/** In-memory state store for tests and dry isolated runs (no disk writes). */
export class MemoryStateStore implements StateStore {
  private state: MonitorState = { cursor: 0, lastSeenStatusIdByHandle: {}, processedKeys: [] };
  readonly tracked: TrackedPost[] = [];

  constructor(initial?: Partial<MonitorState>) {
    if (initial) this.state = { ...this.state, ...initial };
  }

  async loadState(): Promise<MonitorState> {
    return JSON.parse(JSON.stringify(this.state));
  }
  async saveState(state: MonitorState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
  async recordPost(record: TrackedPost): Promise<void> {
    this.tracked.push(record);
  }
}
