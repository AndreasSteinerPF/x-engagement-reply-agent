import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyCriticalFailure } from "./notify-critical-failure";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyCriticalFailure", () => {
  it("logs a structured ERROR line with the run key, error message, and a PagerDuty TODO", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    notifyCriticalFailure({ runKey: "run-1", error: new Error("DynamoDB unreachable") });

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleError.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged.level).toBe("error");
    expect(logged.message).toBe("CRITICAL: monitor run failed");
    expect(logged.runKey).toBe("run-1");
    expect(logged.error).toBe("DynamoDB unreachable");
    expect(logged.todo).toMatch(/PagerDuty/);
  });

  it("stringifies non-Error thrown values instead of dropping them", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    notifyCriticalFailure({ runKey: "run-2", error: "a plain string was thrown" });

    const logged = JSON.parse(consoleError.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged.error).toBe("a plain string was thrown");
  });

  it("passes through extra context fields alongside runKey/error", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    notifyCriticalFailure({
      runKey: "run-3",
      error: new Error("boom"),
      authorHandle: "exampleauthor",
    });

    const logged = JSON.parse(consoleError.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged.authorHandle).toBe("exampleauthor");
  });
});
