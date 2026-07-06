import { z } from "zod";

// Deployment/runtime-identity values (region, secret ARNs, LangSmith
// project) live in process.env, per the company's convention of splitting
// operational config (SSM/env) from business config (config/*.yaml,
// code-managed per CLAUDE.md). AWS_REGION is a Lambda-reserved env var
// that's always present at runtime; the default here only matters for
// local scripts run outside Lambda.
const RuntimeEnvSchema = z.object({
  AWS_REGION: z.string().min(1).default("us-east-2"),
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_API_KEY_SECRET_ARN: z.string().optional(),

  // Asana identifiers/credentials -- deployment-time, per-environment
  // config (candidate-supplied), not business config, so these are env
  // vars rather than config/settings.yaml fields (see CLAUDE.md).
  ASANA_ACCESS_TOKEN: z.string().optional(),
  ASANA_PROJECT_GID: z.string().optional(),
  ASANA_WORKSPACE_GID: z.string().optional(),
  ASANA_SECTION_GID: z.string().optional(),
  ASANA_ASSIGNEE_GID: z.string().optional(),
  ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID: z.string().optional(),
  ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: z.string().optional(),
  ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: z.string().optional(),
  ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: z.string().optional(),
  ASANA_EXISTING_TASK_DEDUPE_ENABLED: z.string().optional(),

  // X API credentials and the DynamoDB state table name. Optional here
  // (not every caller of loadRuntimeEnv needs them -- e.g. an --live-llm-only
  // local invocation touches neither X nor DynamoDB); handler.ts asserts
  // their presence explicitly before constructing the clients that need
  // them, so the *general* env loader stays usable in narrower contexts.
  X_BEARER_TOKEN: z.string().optional(),
  STATE_TABLE_NAME: z.string().optional(),
});

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

export function loadRuntimeEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const result = RuntimeEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid runtime environment:\n${issues}`);
  }
  return result.data;
}
