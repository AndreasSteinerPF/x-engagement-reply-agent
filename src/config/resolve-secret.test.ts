import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(function FakeSecretsManagerClient() {
    return { send: mockSend };
  }),
  GetSecretValueCommand: vi.fn().mockImplementation(function FakeCommand(input: unknown) {
    return { input };
  }),
}));

import { resolveSecret } from "./resolve-secret";

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({ SecretString: "secret-from-sm" });
});

describe("resolveSecret", () => {
  it("returns the plain value directly without calling Secrets Manager", async () => {
    const result = await resolveSecret({ plainValue: "plain-token", region: "us-east-2" });

    expect(result).toBe("plain-token");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("prefers the plain value over a secret ARN when both are set", async () => {
    const result = await resolveSecret({
      plainValue: "plain-token",
      secretArn: "arn:aws:secretsmanager:us-east-2:123:secret:x",
      region: "us-east-2",
    });

    expect(result).toBe("plain-token");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns undefined when neither a plain value nor an ARN is set", async () => {
    const result = await resolveSecret({ region: "us-east-2" });
    expect(result).toBeUndefined();
  });

  it("fetches from Secrets Manager when only an ARN is provided", async () => {
    const result = await resolveSecret({
      secretArn: "arn:aws:secretsmanager:us-east-2:123:secret:unique-a",
      region: "us-east-2",
    });

    expect(result).toBe("secret-from-sm");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("caches by ARN so a repeat call for the same ARN doesn't re-fetch", async () => {
    const arn = "arn:aws:secretsmanager:us-east-2:123:secret:unique-b";
    await resolveSecret({ secretArn: arn, region: "us-east-2" });
    await resolveSecret({ secretArn: arn, region: "us-east-2" });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("fetches separately for distinct ARNs", async () => {
    await resolveSecret({
      secretArn: "arn:aws:secretsmanager:us-east-2:123:secret:c1",
      region: "us-east-2",
    });
    await resolveSecret({
      secretArn: "arn:aws:secretsmanager:us-east-2:123:secret:c2",
      region: "us-east-2",
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
