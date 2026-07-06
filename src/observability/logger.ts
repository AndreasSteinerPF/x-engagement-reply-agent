export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  [key: string]: unknown;
};

/**
 * Minimal structured JSON logger. Lambda/CloudWatch already captures
 * stdout as log lines, so this is a genuine (if minimal) structured
 * logger, not a throwaway stub -- Phase 6 upgrades this to AWS Lambda
 * Powertools Logger for correlation IDs, log-level filtering, and
 * X-Ray-aware fields (per stack-typescript-for-apis.md), but the
 * JSON-to-stdout mechanism itself doesn't change.
 */
export function logRuntime(entry: LogEntry): void {
  const { level, ...rest } = entry;
  const line = JSON.stringify({ level, timestamp: new Date().toISOString(), ...rest });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
