import { afterEach, describe, expect, it } from "vitest";
import { handler } from "./handler";

// handler.ts is a composition root that wires ~15 real clients/stores
// together; each of them already has its own thorough unit tests, and
// run-monitor.ts (the actual orchestration logic) is tested exhaustively
// with fakes. Re-mocking every dependency here for a handler-level unit
// test would mostly re-test wiring, not behavior. Instead, this test
// exercises handler.ts's own real logic -- failing fast on missing
// required environment variables -- by calling the REAL handler with no
// mocks. This is safe: requireEnv() throws before any client makes a
// network call, so nothing here touches AWS, X, Asana, or Bedrock.
// Real end-to-end wiring is verified via scripts/invoke-local.ts.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("handler", () => {
  it("throws immediately when X_BEARER_TOKEN is not configured", async () => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.STATE_TABLE_NAME;

    await expect(handler()).rejects.toThrow(
      /Missing required environment variable: X_BEARER_TOKEN/,
    );
  });

  it("throws immediately when STATE_TABLE_NAME is not configured", async () => {
    process.env.X_BEARER_TOKEN = "test-token";
    delete process.env.STATE_TABLE_NAME;

    await expect(handler()).rejects.toThrow(
      /Missing required environment variable: STATE_TABLE_NAME/,
    );
  });
});
