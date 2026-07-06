import { describe, expect, it } from "vitest";
import { loadRuntimeEnv } from "./env";

describe("loadRuntimeEnv", () => {
  it("defaults AWS_REGION to us-east-2 when unset", () => {
    const env = loadRuntimeEnv({});
    expect(env.AWS_REGION).toBe("us-east-2");
  });

  it("passes through explicit values and ignores unrelated env vars", () => {
    const env = loadRuntimeEnv({
      AWS_REGION: "us-west-2",
      LANGSMITH_PROJECT: "x-engagement-reply-agent",
      PATH: "/usr/bin",
    });

    expect(env.AWS_REGION).toBe("us-west-2");
    expect(env.LANGSMITH_PROJECT).toBe("x-engagement-reply-agent");
    expect(env).not.toHaveProperty("PATH");
  });

  it("throws when AWS_REGION is present but empty", () => {
    expect(() => loadRuntimeEnv({ AWS_REGION: "" })).toThrow(/Invalid runtime environment/);
  });

  it("passes through Asana configuration values when present", () => {
    const env = loadRuntimeEnv({
      ASANA_ACCESS_TOKEN: "token",
      ASANA_PROJECT_GID: "123",
      ASANA_SECTION_GID: "456",
    });

    expect(env.ASANA_ACCESS_TOKEN).toBe("token");
    expect(env.ASANA_PROJECT_GID).toBe("123");
    expect(env.ASANA_SECTION_GID).toBe("456");
  });

  it("leaves Asana configuration undefined when absent", () => {
    const env = loadRuntimeEnv({});
    expect(env.ASANA_ACCESS_TOKEN).toBeUndefined();
    expect(env.ASANA_PROJECT_GID).toBeUndefined();
  });
});
