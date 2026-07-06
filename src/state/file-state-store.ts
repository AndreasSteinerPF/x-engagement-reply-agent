import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CursorStore } from "./cursor-store";
import type { DedupeStore, MarkProcessedParams } from "./dedupe-store";

export type FileStateStore = CursorStore & DedupeStore;

type FileStateShape = {
  cursors: Record<string, string>;
  dedupe: Record<string, MarkProcessedParams>;
};

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function dedupeKey(sourceUri: string, statusId: string): string {
  return `${sourceUri}#${statusId}`;
}

async function readState(filePath: string): Promise<FileStateShape> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FileStateShape>;
    return { cursors: parsed.cursors ?? {}, dedupe: parsed.dedupe ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { cursors: {}, dedupe: {} };
    }
    throw error;
  }
}

async function writeState(filePath: string, state: FileStateShape): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * A CursorStore + DedupeStore backed by one JSON file instead of DynamoDB.
 * The in-memory fakes scripts/invoke-local.ts otherwise uses reset on every
 * process exit, so two separate `invoke-local` invocations can never prove
 * idempotency ("run it twice, no duplicate task") without a real DynamoDB
 * table. This persists to disk between invocations instead, so that proof
 * works entirely locally with zero AWS access. Read-modify-write per call is
 * fine for this single-process CLI use case; the real Lambda handler always
 * uses the real DynamoDB-backed stores (cursor-store.ts, dedupe-store.ts),
 * never this one.
 */
export function createFileStateStore(filePath: string): FileStateStore {
  async function getCursor(handle: string): Promise<string | null> {
    const state = await readState(filePath);
    return state.cursors[normalizeHandle(handle)] ?? null;
  }

  async function setCursor(handle: string, statusId: string): Promise<void> {
    const state = await readState(filePath);
    state.cursors[normalizeHandle(handle)] = statusId;
    await writeState(filePath, state);
  }

  async function hasProcessed(sourceUri: string, statusId: string): Promise<boolean> {
    const state = await readState(filePath);
    return dedupeKey(sourceUri, statusId) in state.dedupe;
  }

  async function markProcessed(params: MarkProcessedParams): Promise<void> {
    const state = await readState(filePath);
    state.dedupe[dedupeKey(params.sourceUri, params.statusId)] = params;
    await writeState(filePath, state);
  }

  return { getCursor, setCursor, hasProcessed, markProcessed };
}
