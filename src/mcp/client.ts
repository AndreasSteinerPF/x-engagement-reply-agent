/**
 * Minimal Streamable-HTTP MCP client for the hosted investors-mcp server.
 *
 * The server speaks JSON-RPC over HTTP and replies with `text/event-stream`
 * (SSE) even for unary calls, and runs statelessly (no `mcp-session-id`). Reads
 * require no auth. This client implements exactly what the agent needs:
 * `tools/call` for `queryInvestorContent` / `listInvestorContent`.
 */

export const DEFAULT_MCP_URL = "https://investors-mcp.vercel.app/mcp";

export interface McpClientOptions {
  url?: string;
  timeoutMs?: number;
  /** Optional bearer token (only needed for write tools; reads are open). */
  token?: string;
}

export interface QueryInvestorContentArgs {
  query: string;
  author?: string;
  company?: string;
  contentType?: "post" | "article";
  segmentType?: "post_full" | "article_full" | "article_paragraph";
  dateFrom?: string;
  dateTo?: string;
  topK?: number;
}

/** One raw match as returned by the MCP (blob/metadata are Python-literal strings). */
export interface RawMatch {
  id: string;
  score: number | string;
  key: string;
  metadata: unknown;
  blob: unknown;
  blobError?: string;
}

export interface QueryInvestorContentResult {
  query: string;
  topK: number;
  matchCount: number;
  matches: RawMatch[];
  author?: string;
  authorNormalized?: string;
  authorResolvedKeys?: string[];
  contentType?: string;
  segmentType?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly token?: string;
  private idCounter = 0;

  constructor(opts: McpClientOptions = {}) {
    this.url = opts.url ?? process.env.MCP_URL ?? DEFAULT_MCP_URL;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.token = opts.token ?? process.env.MCP_READ_TOKEN;
  }

  get endpoint(): string {
    return this.url;
  }

  /** Call `queryInvestorContent` with topK clamped to the server's [1,20] bound. */
  async queryInvestorContent(args: QueryInvestorContentArgs): Promise<QueryInvestorContentResult> {
    const topK = clamp(args.topK ?? 5, 1, 20);
    const result = await this.callTool("queryInvestorContent", { ...args, topK });
    return result as QueryInvestorContentResult;
  }

  /** Generic `tools/call`; returns the parsed structured payload from the text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = ++this.idCounter;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new McpError(`MCP request to ${this.url} failed`, err);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new McpError(`MCP returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const rpc = parseRpcResponse(await res.text());
    if (rpc.error) throw new McpError(`MCP tool error: ${JSON.stringify(rpc.error)}`);
    const content = (rpc.result as { content?: Array<{ type: string; text?: string }> })?.content;
    const textItem = content?.find((c) => c.type === "text" && typeof c.text === "string");
    if (!textItem?.text) throw new McpError("MCP response had no text content");
    try {
      return JSON.parse(textItem.text);
    } catch (err) {
      throw new McpError("MCP text content was not JSON", err);
    }
  }
}

/** Parse a JSON-RPC response that may arrive as plain JSON or as SSE `data:` frames. */
export function parseRpcResponse(raw: string): { result?: unknown; error?: unknown } {
  const trimmed = raw.trim();
  // Plain JSON
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  // SSE: collect `data:` lines, parse each JSON, return the last with result/error.
  let last: { result?: unknown; error?: unknown } | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m || !m[1]) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && (("result" in obj) || ("error" in obj))) last = obj;
    } catch {
      /* skip non-JSON data frames */
    }
  }
  if (!last) throw new McpError("Could not parse MCP SSE response");
  return last;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
