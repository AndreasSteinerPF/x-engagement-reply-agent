import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createRotationStore } from "./rotation-store";

const TABLE_NAME = "test-table";
const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  ddbMock.reset();
});

describe("createRotationStore", () => {
  const store = createRotationStore(doc, TABLE_NAME);

  it("returns 0 when no cursor index has been set", async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await store.getCursorIndex();
    expect(result).toBe(0);
  });

  it("returns the stored cursorIndex", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { cursorIndex: 3 } });
    const result = await store.getCursorIndex();
    expect(result).toBe(3);
  });

  it("reads from a single fixed key, not per-handle", async () => {
    ddbMock.on(GetCommand).resolves({});
    await store.getCursorIndex();

    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input.Key).toEqual({ pk: "RUN#ROTATION", sk: "STATE" });
  });

  it("writes the cursorIndex to the same fixed key", async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.setCursorIndex(5);

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item).toMatchObject({
      pk: "RUN#ROTATION",
      sk: "STATE",
      cursorIndex: 5,
    });
  });
});
