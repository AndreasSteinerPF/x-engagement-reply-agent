import type { AsanaClient } from "../../ports.js";
import { OfflineAsanaClient } from "./offline.js";
import { LiveAsanaClient } from "./live.js";

export { OfflineAsanaClient } from "./offline.js";
export { LiveAsanaClient } from "./live.js";
export * from "./notes.js";

export interface AsanaClientSelection {
  client: AsanaClient;
  mode: "live" | "offline";
}

/**
 * Select the Asana client. Uses the live API when `ASANA_ACCESS_TOKEN` +
 * `ASANA_PROJECT_GID` are present; otherwise the offline sink that writes the
 * would-be task payloads to `<outDir>/asana/`.
 */
export function createAsanaClient(opts: {
  outDir: string;
  thresholds: { asanaTaskSimilarityThreshold: number; articleSimilarityThreshold: number };
}): AsanaClientSelection {
  const live = LiveAsanaClient.fromEnv();
  if (live) return { client: live, mode: "live" };
  return { client: new OfflineAsanaClient(opts.outDir, opts.thresholds), mode: "offline" };
}
