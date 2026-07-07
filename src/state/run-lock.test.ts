import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createRunLock } from "./run-lock";

const TABLE_NAME = "test-table";
const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

beforeEach(() => {
  ddbMock.reset();
});

describe("createRunLock", () => {
  const lock = createRunLock(doc, TABLE_NAME);

  it("acquires the lock when no one else holds it", async () => {
    ddbMock.on(PutCommand).resolves({});
    const result = await lock.acquireLock({ owner: "run-1", ttlSeconds: 600 });
    expect(result).toEqual({ acquired: true });
  });

  it("uses a conditional expression that allows re-acquiring an expired lock", async () => {
    ddbMock.on(PutCommand).resolves({});
    await lock.acquireLock({ owner: "run-1", ttlSeconds: 600 });

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR expiresAt < :now",
    );
  });

  it("reports lock-busy with the existing owner when the condition fails", async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    ddbMock.on(GetCommand).resolves({
      Item: { owner: "run-0", expiresAt: "2026-01-01T00:10:00.000Z" },
    });

    const result = await lock.acquireLock({ owner: "run-1", ttlSeconds: 600 });

    expect(result).toEqual({
      acquired: false,
      reason: "lock-busy",
      owner: "run-0",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
  });

  it("propagates unexpected errors from acquireLock", async () => {
    ddbMock.on(PutCommand).rejects(new Error("network blip"));
    await expect(lock.acquireLock({ owner: "run-1", ttlSeconds: 600 })).rejects.toThrow(
      "network blip",
    );
  });

  it("releases the lock when the caller owns it", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(lock.releaseLock("run-1")).resolves.toBeUndefined();

    const call = ddbMock.commandCalls(DeleteCommand)[0];
    // "owner" is a DynamoDB reserved keyword -- must be aliased via
    // ExpressionAttributeNames, not written literally in the expression
    // (a real ValidationException from live DynamoDB, invisible to this
    // mock, which doesn't validate expression syntax -- see run-lock.ts).
    expect(call.args[0].input.ConditionExpression).toBe("#owner = :owner");
    expect(call.args[0].input.ExpressionAttributeNames).toEqual({ "#owner": "owner" });
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ":owner": "run-1" });
  });

  it("treats releasing a lock that was already reacquired by someone else as a safe no-op", async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());
    await expect(lock.releaseLock("stale-owner")).resolves.toBeUndefined();
  });

  it("propagates unexpected errors from releaseLock", async () => {
    ddbMock.on(DeleteCommand).rejects(new Error("network blip"));
    await expect(lock.releaseLock("run-1")).rejects.toThrow("network blip");
  });
});
