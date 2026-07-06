import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_INVESTORS_MCP_ENDPOINT = "https://investors-mcp.vercel.app/mcp";

export type McpMatch = {
  id: string;
  score: number;
  key: string;
  metadata: Record<string, unknown>;
  blob: { sourceUri?: string; title?: string; content?: string } | null;
  blobError?: string;
};

export type QueryInvestorContentResponse = {
  query: string;
  topK: number;
  matchCount: number;
  matches: McpMatch[];
};

export type QueryInvestorContentParams = {
  query: string;
  author?: string;
  company?: string;
  contentType?: string;
  segmentType?: string;
  topK?: number;
};

export type ListInvestorContentParams = Record<string, unknown>;

export type InvestorMcpClient = {
  queryInvestorContent: (
    params: QueryInvestorContentParams,
  ) => Promise<QueryInvestorContentResponse>;
  listInvestorContent: (params: ListInvestorContentParams) => Promise<unknown>;
  close: () => Promise<void>;
};

export type InvestorMcpClientOptions = {
  endpoint?: string;
};

/**
 * Thin client over the hosted investors-mcp Streamable HTTP MCP server.
 * Uses the official @modelcontextprotocol/sdk transport rather than
 * hand-rolled JSON-RPC -- session/SSE handling is easy to get subtly wrong
 * by hand (see docs/implementation-plan.md).
 *
 * Read-only by construction: this module has no code path for
 * `addInvestorParagraph` (the write tool) at all, not even gated behind a
 * flag -- write access is not provided to this agent, and dry-run/local
 * testing must never risk calling a write tool.
 */
export function createInvestorMcpClient(options: InvestorMcpClientOptions = {}): InvestorMcpClient {
  const endpoint = options.endpoint ?? DEFAULT_INVESTORS_MCP_ENDPOINT;
  let clientPromise: Promise<Client> | null = null;

  async function getClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const transport = new StreamableHTTPClientTransport(new URL(endpoint));
        const client = new Client({ name: "x-engagement-reply-agent", version: "0.1.0" });
        await client.connect(transport);
        return client;
      })();
    }
    return clientPromise;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await getClient();
    const result = await client.callTool({ name, arguments: args });
    return parseToolResult(result);
  }

  async function queryInvestorContent(
    params: QueryInvestorContentParams,
  ): Promise<QueryInvestorContentResponse> {
    return (await callTool("queryInvestorContent", { ...params })) as QueryInvestorContentResponse;
  }

  async function listInvestorContent(params: ListInvestorContentParams): Promise<unknown> {
    return callTool("listInvestorContent", params);
  }

  async function close(): Promise<void> {
    if (!clientPromise) return;
    const client = await clientPromise;
    await client.close();
  }

  return { queryInvestorContent, listInvestorContent, close };
}

function parseToolResult(result: unknown): unknown {
  const typed = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const textBlock = typed.content?.find(
    (block): block is { type: string; text: string } =>
      block.type === "text" && typeof block.text === "string",
  );

  if (!textBlock) {
    throw new Error("MCP tool result did not contain a text content block");
  }

  const parsed: unknown = JSON.parse(textBlock.text);

  if (typed.isError) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : "Unknown MCP tool error";
    throw new Error(`MCP tool error: ${message}`);
  }

  return parsed;
}
