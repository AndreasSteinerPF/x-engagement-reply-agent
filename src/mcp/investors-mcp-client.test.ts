import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function FakeClient() {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function FakeTransport() {
    return {};
  }),
}));

// `vi.mock` calls above are hoisted above this import by Vitest, so the
// mocked SDK modules are already in place by the time this module loads.
import { createInvestorMcpClient } from "./investors-mcp-client";

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockCallTool.mockReset();
  mockClose.mockReset().mockResolvedValue(undefined);
});

describe("createInvestorMcpClient", () => {
  it("calls queryInvestorContent and parses the JSON text content block", async () => {
    mockCallTool.mockResolvedValue(textResult({ query: "q", topK: 5, matchCount: 0, matches: [] }));

    const client = createInvestorMcpClient();
    const result = await client.queryInvestorContent({ query: "q", topK: 5 });

    expect(result).toEqual({ query: "q", topK: 5, matchCount: 0, matches: [] });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "queryInvestorContent",
      arguments: { query: "q", topK: 5 },
    });
  });

  it("passes the required Soofi-article query shape through unchanged", async () => {
    mockCallTool.mockResolvedValue(
      textResult({ query: "post text", topK: 40, matchCount: 0, matches: [] }),
    );

    const client = createInvestorMcpClient();
    await client.queryInvestorContent({
      query: "post text",
      author: "Soofi Safavi",
      contentType: "article",
      segmentType: "article_full",
      topK: 40,
    });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: "queryInvestorContent",
      arguments: {
        query: "post text",
        author: "Soofi Safavi",
        contentType: "article",
        segmentType: "article_full",
        topK: 40,
      },
    });
  });

  it("connects only once across multiple calls", async () => {
    mockCallTool.mockResolvedValue(textResult({ query: "a", topK: 1, matchCount: 0, matches: [] }));

    const client = createInvestorMcpClient();
    await client.queryInvestorContent({ query: "a" });
    await client.queryInvestorContent({ query: "b" });

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("calls listInvestorContent with its own tool name", async () => {
    mockCallTool.mockResolvedValue(textResult({ items: [] }));

    const client = createInvestorMcpClient();
    await client.listInvestorContent({ author: "Soofi Safavi" });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: "listInvestorContent",
      arguments: { author: "Soofi Safavi" },
    });
  });

  it("rejects a successful result whose matches don't match the expected shape", async () => {
    // `score` missing on the match -- a real shape drift must fail loudly
    // here rather than corrupt similarity-gating math three modules away.
    mockCallTool.mockResolvedValue(
      textResult({
        query: "q",
        topK: 5,
        matchCount: 1,
        matches: [{ id: "1", key: "k", metadata: {}, blob: null }],
      }),
    );

    const client = createInvestorMcpClient();
    await expect(client.queryInvestorContent({ query: "q" })).rejects.toThrow(
      /did not match the expected shape/,
    );
  });

  it("throws a descriptive error when the tool result has isError: true", async () => {
    mockCallTool.mockResolvedValue(textResult({ error: "boom" }, true));

    const client = createInvestorMcpClient();
    await expect(client.queryInvestorContent({ query: "q" })).rejects.toThrow(
      /MCP tool error: boom/,
    );
  });

  it("throws when the result has no text content block", async () => {
    mockCallTool.mockResolvedValue({ content: [] });

    const client = createInvestorMcpClient();
    await expect(client.queryInvestorContent({ query: "q" })).rejects.toThrow(
      /did not contain a text content block/,
    );
  });

  it("closes the underlying client once connected", async () => {
    mockCallTool.mockResolvedValue(textResult({ query: "q", topK: 1, matchCount: 0, matches: [] }));

    const client = createInvestorMcpClient();
    await client.queryInvestorContent({ query: "q" });
    await client.close();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to close a client that was never connected", async () => {
    const client = createInvestorMcpClient();
    await client.close();
    expect(mockClose).not.toHaveBeenCalled();
  });
});
