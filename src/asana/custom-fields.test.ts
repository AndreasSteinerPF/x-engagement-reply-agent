import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../config/env";
import { buildSimilarityCustomFields, resolveSimilarityFieldGids } from "./custom-fields";

function env(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { AWS_REGION: "us-east-2", ...overrides };
}

describe("resolveSimilarityFieldGids", () => {
  it("returns empty strings when nothing is configured", () => {
    expect(resolveSimilarityFieldGids(env())).toEqual({
      parentTaskFieldGid: "",
      subtaskFieldGid: "",
    });
  });

  it("uses the shared GID for both parent and subtask when only it is set", () => {
    const result = resolveSimilarityFieldGids(
      env({ ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "shared" }),
    );
    expect(result).toEqual({ parentTaskFieldGid: "shared", subtaskFieldGid: "shared" });
  });

  it("prefers the task-specific GID over the shared one for the parent task", () => {
    const result = resolveSimilarityFieldGids(
      env({
        ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "shared",
        ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "task",
      }),
    );
    expect(result.parentTaskFieldGid).toBe("task");
  });

  it("prefers the subtask-specific GID, falling back to shared, falling back to the resolved parent GID", () => {
    expect(
      resolveSimilarityFieldGids(
        env({ ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "subtask" }),
      ).subtaskFieldGid,
    ).toBe("subtask");
    expect(
      resolveSimilarityFieldGids(env({ ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "shared" }))
        .subtaskFieldGid,
    ).toBe("shared");
    expect(
      resolveSimilarityFieldGids(env({ ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: "task" }))
        .subtaskFieldGid,
    ).toBe("task");
  });
});

describe("buildSimilarityCustomFields", () => {
  it("returns a custom_fields object keyed by the field gid", () => {
    expect(buildSimilarityCustomFields("field-1", 82)).toEqual({ "field-1": 82 });
  });

  it("returns null when the field gid is blank", () => {
    expect(buildSimilarityCustomFields("", 82)).toBeNull();
    expect(buildSimilarityCustomFields("   ", 82)).toBeNull();
  });

  it("returns null when the score is null, undefined, or non-finite", () => {
    expect(buildSimilarityCustomFields("field-1", null)).toBeNull();
    expect(buildSimilarityCustomFields("field-1", undefined)).toBeNull();
    expect(buildSimilarityCustomFields("field-1", Number.NaN)).toBeNull();
  });

  it("allows a score of 0", () => {
    expect(buildSimilarityCustomFields("field-1", 0)).toEqual({ "field-1": 0 });
  });
});
