import type { RunSummary } from "@agent-network/contract";
import type { Logger } from "./obs/logger.js";

/**
 * Posts a run summary to the Agent Network Platform's run-ingest endpoint.
 * This is how the agent contributes to network usage metrics once it is
 * registered. Best-effort: a failure here never fails the run.
 */
export async function postRunSummary(
  platformUrl: string,
  summary: RunSummary,
  logger: Logger,
): Promise<boolean> {
  const url = `${platformUrl.replace(/\/$/, "")}/api/agents/${summary.agentId}/runs`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    });
    if (!res.ok) {
      logger.warn("registry run-report failed", { url, status: res.status });
      return false;
    }
    logger.info("reported run to registry", { url });
    return true;
  } catch (err) {
    logger.warn("registry run-report error", { url, error: (err as Error).message });
    return false;
  }
}
