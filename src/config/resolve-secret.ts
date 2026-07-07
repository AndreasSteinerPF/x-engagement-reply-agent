import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const cache = new Map<string, string>();

/**
 * Resolves a credential that may be supplied either as a plain value
 * (local dev via .env) or as a Secrets Manager ARN (deployed Lambda --
 * never pass raw tokens as plaintext Lambda environment variables). The
 * plain value always wins if both are set, since that's the local-dev
 * override path. Each distinct ARN is fetched once per process and cached,
 * matching the caching behavior this replaces in
 * src/observability/langsmith.ts.
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

  const client = new SecretsManagerClient({ region: params.region });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) return undefined;

  cache.set(arn, result.SecretString);
  return result.SecretString;
}
