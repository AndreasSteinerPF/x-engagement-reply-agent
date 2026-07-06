import { logRuntime } from "./logger";

export type CriticalFailureContext = {
  runKey: string;
  error: unknown;
} & Record<string, unknown>;

/**
 * Structural seam for paging on-call when the monitor run fails critically
 * -- an error escaping runMonitor's own per-author isolation (e.g. a config
 * load failure, or Asana/DynamoDB being completely unreachable), not a
 * normal per-post skip. No real PagerDuty account exists for this
 * take-home (see docs/deployment.md); this logs a structured ERROR with
 * full context so both the failure and what should happen with it in
 * production are explicit, rather than the pipeline silently having no
 * failure-paging path at all.
 */
export function notifyCriticalFailure(context: CriticalFailureContext): void {
  const { error, ...rest } = context;
  logRuntime({
    level: "error",
    message: "CRITICAL: monitor run failed",
    ...rest,
    error: error instanceof Error ? error.message : String(error),
    todo: "production: wire PagerDuty Events API v2 (trigger action) here",
  });
}
