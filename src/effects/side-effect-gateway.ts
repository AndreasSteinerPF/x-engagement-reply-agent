import type { AsanaClient } from "../asana/client";
import type { AsanaTaskingResult, CreateAsanaTaskingParams } from "../asana/create-asana-tasking";
import { createAsanaTasking } from "../asana/create-asana-tasking";
import type { AsanaDedupeCache } from "../asana/dedupe";
import type { RuntimeEnv } from "../config/env";
import type { RunSummary } from "../orchestration/run-monitor";
import type { CursorStore } from "../state/cursor-store";
import type { DedupeStore, MarkProcessedParams } from "../state/dedupe-store";
import type { RunSummaryStore } from "../state/run-summary-store";

export type ProcessAsanaTaskingParams = Omit<
  CreateAsanaTaskingParams,
  "asanaClient" | "dedupeCache" | "env"
>;

export type SideEffectGateway = {
  readonly dryRun: boolean;
  processAsanaTasking: (params: ProcessAsanaTaskingParams) => Promise<AsanaTaskingResult>;
  writeCursor: (handle: string, statusId: string) => Promise<void>;
  writeDedupeKey: (params: MarkProcessedParams) => Promise<void>;
  writeRunSummary: (summary: RunSummary) => Promise<void>;
};

export type LiveSideEffectGatewayDeps = {
  asanaClient: AsanaClient;
  dedupeCache: AsanaDedupeCache;
  env: RuntimeEnv;
  cursorStore: CursorStore;
  dedupeStore: DedupeStore;
  runSummaryStore: RunSummaryStore;
};

/**
 * The single seam every external WRITE passes through (MCP reads and X
 * reads do not go through this -- they're read-only/needed-for-detection
 * respectively, and execute the same way in both modes; see
 * docs/implementation-plan.md, "Dry-run mode"). Live mode performs real
 * Asana POSTs (including the existing-task dedupe GET scan) and real
 * DynamoDB writes. Dry-run mode makes zero network calls for any of this
 * -- not even the Asana existing-task scan, not even persisting the run
 * summary -- so a dry run is always safe to run against production Asana
 * data and always fully repeatable.
 */
export function createLiveSideEffectGateway(deps: LiveSideEffectGatewayDeps): SideEffectGateway {
  return {
    dryRun: false,
    processAsanaTasking: (params) =>
      createAsanaTasking({
        ...params,
        asanaClient: deps.asanaClient,
        dedupeCache: deps.dedupeCache,
        env: deps.env,
      }),
    writeCursor: (handle, statusId) => deps.cursorStore.setCursor(handle, statusId),
    writeDedupeKey: (params) => deps.dedupeStore.markProcessed(params),
    writeRunSummary: (summary) => deps.runSummaryStore.writeRunSummary(summary),
  };
}

export function createDryRunSideEffectGateway(): SideEffectGateway {
  return {
    dryRun: true,
    processAsanaTasking: async () => ({ created: false, reason: "dry-run" }),
    writeCursor: async () => {},
    writeDedupeKey: async () => {},
    writeRunSummary: async () => {},
  };
}
