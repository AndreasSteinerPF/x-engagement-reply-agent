import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createDedupeStore } from "./dedupe-store";

const TABLE_NAME = "test-table";
const TTL_DAYS = 90;
const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  ddbMock.reset();
});

describe("createDedupeStore", () => {
  const store = createDedupeStore(doc, TABLE_NAME, TTL_DAYS);
  const sourceUri = "https://x.com/exampleauthor/status/123";
  const statusId = "123";

  it("returns false when the post has not been processed", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await store.hasProcessed(sourceUri, statusId)).toBe(false);
  });

  it("returns true when a dedupe entry exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { outcome: "tasked" } });
    expect(await store.hasProcessed(sourceUri, statusId)).toBe(true);
  });

  it("keys the dedupe entry by sourceUri + statusId", async () => {
    ddbMock.on(GetCommand).resolves({});
    await store.hasProcessed(sourceUri, statusId);

    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input.Key).toEqual({
      pk: `POST#${sourceUri}`,
      sk: `STATUS#${statusId}`,
    });
  });

  it("writes the outcome and a TTL derived from ttlDays", async () => {
    ddbMock.on(PutCommand).resolves({});
    const beforeSeconds = Math.floor(Date.now() / 1000);

    await store.markProcessed({ sourceUri, statusId, outcome: "tasked", asanaTaskGid: "gid-1" });

    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe(`POST#${sourceUri}`);
    expect(item.sk).toBe(`STATUS#${statusId}`);
    expect(item.outcome).toBe("tasked");
    expect(item.asanaTaskGid).toBe("gid-1");
    expect(item.ttl as number).toBeGreaterThanOrEqual(beforeSeconds + TTL_DAYS * 86_400);
  });

  it("omits asanaTaskGid when not provided", async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.markProcessed({ sourceUri, statusId, outcome: "skipped" });

    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.asanaTaskGid).toBeUndefined();
  });
});
