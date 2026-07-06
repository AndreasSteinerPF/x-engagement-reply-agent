export type MonitorRunResult = {
  ok: true;
  message: string;
};

/**
 * Placeholder Lambda entrypoint. Replaced in Phase 5 by the real
 * cost-gate -> lock -> runMonitor -> notifyCriticalFailure orchestration
 * described in docs/implementation-plan.md.
 */
export async function handler(): Promise<MonitorRunResult> {
  return { ok: true, message: "x-engagement-reply-agent scaffold is alive" };
}
