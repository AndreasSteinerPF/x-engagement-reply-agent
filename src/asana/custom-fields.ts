import type { RuntimeEnv } from "../config/env";

export type SimilarityFieldGids = {
  parentTaskFieldGid: string;
  subtaskFieldGid: string;
};

/**
 * Ported from investors-mcp's getAsanaSimilarityScoreFieldGids: a shared
 * custom-field GID is the default for both parent tasks and subtasks;
 * either can be overridden independently with its own GID.
 */
export function resolveSimilarityFieldGids(env: RuntimeEnv): SimilarityFieldGids {
  const shared = (env.ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID ?? "").trim();
  const parentTaskFieldGid =
    (env.ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID ?? "").trim() || shared;
  const subtaskFieldGid =
    (env.ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID ?? "").trim() ||
    shared ||
    parentTaskFieldGid;

  return { parentTaskFieldGid, subtaskFieldGid };
}

/**
 * Ported from investors-mcp's buildAsanaSimilarityCustomFields. Returns
 * null (omit `custom_fields` entirely) when no field GID resolved or the
 * score isn't a finite number -- never send a custom_fields object with a
 * blank key or a NaN value.
 */
export function buildSimilarityCustomFields(
  customFieldGid: string,
  score: number | null | undefined,
): Record<string, number> | null {
  const normalizedFieldGid = customFieldGid.trim();
  if (!normalizedFieldGid) return null;
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return { [normalizedFieldGid]: score };
}
