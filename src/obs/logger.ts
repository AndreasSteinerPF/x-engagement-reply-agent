/**
 * Structured logger. Emits one JSON object per line to stdout (machine-readable
 * run telemetry) and a compact human line to stderr. A child logger carries
 * run-scoped fields (e.g. runId) onto every record.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** When false, suppress the human-readable stderr line (used in tests). */
  pretty?: boolean;
  context?: Record<string, unknown>;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly pretty: boolean;
  private readonly context: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info";
    this.pretty = opts.pretty ?? process.env.LOG_JSON !== "1";
    this.context = opts.context ?? {};
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger({ level: this.level, pretty: this.pretty, context: { ...this.context, ...context } });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = { ts: new Date().toISOString(), level, msg, ...this.context, ...fields };
    process.stdout.write(JSON.stringify(record) + "\n");
    if (this.pretty) {
      process.stderr.write(`${color(level)}${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}${fieldsTail(fields)}\n`);
    }
  }
}

function fieldsTail(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? `  \x1b[2m${parts.join(" ")}\x1b[0m` : "";
}

function color(level: LogLevel): string {
  return { debug: "\x1b[2m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" }[level];
}
