import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReplyGenerationTrace } from "../ports.js";

/**
 * LLM observability. Every reply-generation run (offline-deterministic or a real
 * model) appends a trace record to `.out/traces/<runId>.jsonl`, satisfying the
 * "traceability of LLM reply-generation runs" requirement regardless of
 * provider. Records are also echoed to the run logger by the caller.
 */
export interface TraceRecord extends ReplyGenerationTrace {
  runId: string;
  postStatusId: string;
  articleSourceUri: string;
}

export class TraceSink {
  constructor(
    private readonly dir: string,
    private readonly runId: string,
  ) {}

  get file(): string {
    return join(this.dir, `${this.runId}.jsonl`);
  }

  async write(record: Omit<TraceRecord, "runId">): Promise<void> {
    const line = JSON.stringify({ runId: this.runId, ...record }) + "\n";
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, line, "utf8");
  }
}

/** A no-op sink for dry pipelines/tests that should not touch disk. */
export class NullTraceSink {
  get file(): string {
    return "";
  }
  async write(): Promise<void> {
    /* no-op */
  }
}

/**
 * In-memory trace sink for the serverless web runtime: collects every LLM
 * reply-generation trace so the run page can render them (the "traceability of
 * LLM runs" demo) without writing JSONL to a (read-only) serverless filesystem.
 */
export class MemoryTraceSink {
  readonly records: TraceRecord[] = [];
  constructor(private readonly runId: string) {}
  get file(): string {
    return `memory:${this.runId}`;
  }
  async write(record: Omit<TraceRecord, "runId">): Promise<void> {
    this.records.push({ runId: this.runId, ...record });
  }
}

export type AnyTraceSink = TraceSink | NullTraceSink | MemoryTraceSink;
