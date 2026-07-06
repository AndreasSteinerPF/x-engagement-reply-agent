import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the underlying value when it settles before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test call");
    expect(result).toBe("ok");
  });

  it("rejects with a labeled error when the promise never settles in time", async () => {
    const neverResolves = new Promise<string>(() => {});
    await expect(withTimeout(neverResolves, 10, "slow call")).rejects.toThrow(
      /slow call timed out after 10ms/,
    );
  });

  it("propagates the underlying rejection when it rejects before the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test call")).rejects.toThrow(
      "boom",
    );
  });
});
