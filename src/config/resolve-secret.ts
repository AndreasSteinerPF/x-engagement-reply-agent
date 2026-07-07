import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { logRuntime } from "../observability/logger";

const cache = new Map<string, string>();

/**
 * Resolves a credential that may be supplied either as a plain value
 * (local dev via .env) or as a Secrets Manager ARN (deployed Lambda --
 * never pass raw tokens as plaintext Lambda environment variables). The
 * plain value always wins if both are set, since that's the local-dev
 * override path. Each distinct ARN is fetched once per process and cached,
 * matching the caching behavior this replaces in
 * src/observability/langsmith.ts.
 *
 * A Secrets Manager failure (missing secret, denied access, outage) is
 * logged and treated as "not resolvable" (returns undefined) rather than
 * thrown -- required-vs-optional is the *caller's* concern, not this
 * helper's: src/observability/langsmith.ts's "degrades gracefully without a
 * key" promise depends on this never throwing, while handler.ts's
 * requireEnv() already turns an undefined Asana/X token into a clear
 * "Missing required environment variable" error either way. Letting a raw
 * AWS SDK exception escape instead would produce a confusing stack trace
 * for the same underlying condition, not a functional difference.
 */
export async function resolveSecret(params: {
  plainValue?: string;
  secretArn?: string;
  region: string;
}): Promise<string | undefined> {
  if (params.plainValue?.trim()) {
    return params.plainValue.trim();
  }

  const arn = params.secretArn?.trim();
  if (!arn) return undefined;

  const cached = cache.get(arn);
  if (cached) return cached;

  try {
    const client = new SecretsManagerClient({ region: params.region });
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!result.SecretString) return undefined;

    cache.set(arn, result.SecretString);
    return result.SecretString;
  } catch (error) {
    logRuntime({
      level: "warn",
      message: "Failed to resolve secret from Secrets Manager",
      secretArn: arn,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
