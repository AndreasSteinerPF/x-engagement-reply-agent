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
