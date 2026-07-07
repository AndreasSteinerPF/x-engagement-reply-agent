import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(function FakeSecretsManagerClient() {
    return { send: mockSend };
  }),
  GetSecretValueCommand: vi.fn().mockImplementation(function FakeCommand(input: unknown) {
    return { input };
  }),
}));

const mockRunHandlerCore = vi.fn();
vi.mock("./handler", () => ({
  runHandlerCore: (...args: unknown[]) => mockRunHandlerCore(...args),
}));

import { httpHandler } from "./http-handler";

const ORIGINAL_ENV = { ...process.env };

function fakeEvent(overrides: Record<string, unknown> = {}): APIGatewayProxyEventV2 {
  const base = {
    headers: {},
    queryStringParameters: undefined,
    requestContext: { http: { method: "POST" } },
  };
  return { ...base, ...overrides } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  process.env.EVALUATOR_API_KEY_SECRET_ARN = "arn:aws:secretsmanager:us-east-2:123:secret:key";
  mockSend.mockReset().mockResolvedValue({ SecretString: "correct-key" });
  mockRunHandlerCore.mockReset().mockResolvedValue({ runKey: "run-1", dryRun: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("httpHandler", () => {
  it("serves the HTML page on GET without requiring an API key", async () => {
    const result = await httpHandler(fakeEvent({ requestContext: { http: { method: "GET" } } }));

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("<title>X Engagement Reply Agent");
    expect(mockRunHandlerCore).not.toHaveBeenCalled();
  });

  it("answers CORS preflight without checking the API key", async () => {
    const result = await httpHandler(
      fakeEvent({ requestContext: { http: { method: "OPTIONS" } } }),
    );
    expect(result.statusCode).toBe(204);
    expect(mockRunHandlerCore).not.toHaveBeenCalled();
  });

  it("allows a dry run with no x-api-key header at all -- fully public, matching the competing candidate's own privileged-actions-only gating", async () => {
    const result = await httpHandler(fakeEvent());
    expect(result.statusCode).toBe(200);
    expect(mockRunHandlerCore).toHaveBeenCalledWith(true);
  });

  it("allows a dry run even with a wrong/garbage x-api-key -- the key is simply never checked for dry runs", async () => {
    const result = await httpHandler(fakeEvent({ headers: { "x-api-key": "wrong-key" } }));
    expect(result.statusCode).toBe(200);
    expect(mockRunHandlerCore).toHaveBeenCalledWith(true);
  });

  it("rejects a live (dryRun=false) request with no x-api-key header", async () => {
    const result = await httpHandler(fakeEvent({ queryStringParameters: { dryRun: "false" } }));
    expect(result.statusCode).toBe(401);
    expect(mockRunHandlerCore).not.toHaveBeenCalled();
  });

  it("rejects a live (dryRun=false) request with the wrong x-api-key", async () => {
    const result = await httpHandler(
      fakeEvent({
        headers: { "x-api-key": "wrong-key" },
        queryStringParameters: { dryRun: "false" },
      }),
    );
    expect(result.statusCode).toBe(401);
    expect(mockRunHandlerCore).not.toHaveBeenCalled();
  });

  it("rejects a live request when the secret itself can't be resolved", async () => {
    mockSend.mockReset().mockRejectedValue(new Error("ResourceNotFoundException"));
    const result = await httpHandler(
      fakeEvent({
        headers: { "x-api-key": "anything" },
        queryStringParameters: { dryRun: "false" },
      }),
    );
    expect(result.statusCode).toBe(401);
  });

  it("defaults to dry-run when no dryRun query param is given", async () => {
    await httpHandler(fakeEvent());
    expect(mockRunHandlerCore).toHaveBeenCalledWith(true);
  });

  it("runs live only when dryRun=false is explicitly given, with the correct key", async () => {
    await httpHandler(
      fakeEvent({
        headers: { "x-api-key": "correct-key" },
        queryStringParameters: { dryRun: "false" },
      }),
    );
    expect(mockRunHandlerCore).toHaveBeenCalledWith(false);
  });

  it("treats any dryRun value other than the literal string 'false' as dry-run", async () => {
    await httpHandler(fakeEvent({ queryStringParameters: { dryRun: "true" } }));
    expect(mockRunHandlerCore).toHaveBeenCalledWith(true);
  });

  it("returns the run summary as JSON on a successful dry run", async () => {
    mockRunHandlerCore.mockResolvedValue({ runKey: "run-1", asanaTasksCreated: 1 });
    const result = await httpHandler(fakeEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ runKey: "run-1", asanaTasksCreated: 1 });
  });

  it("returns a clean 500 with the error message when the run throws", async () => {
    mockRunHandlerCore.mockRejectedValue(new Error("boom"));
    const result = await httpHandler(fakeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body as string)).toEqual({ error: "boom" });
  });

  it("includes CORS headers on every response", async () => {
    const result = await httpHandler(fakeEvent());
    expect(result.headers?.["access-control-allow-origin"]).toBe("*");
  });
});
