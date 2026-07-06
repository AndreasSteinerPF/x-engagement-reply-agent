import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createCursorStore, isNewerStatusId } from "./cursor-store";

const TABLE_NAME = "test-table";
const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  ddbMock.reset();
});

describe("isNewerStatusId", () => {
  it("treats any candidate as newer when there is no current cursor", () => {
    expect(isNewerStatusId("123", null)).toBe(true);
  });

  it("compares snowflake IDs as BigInt, not as strings or Numbers", () => {
    // Larger than Number.MAX_SAFE_INTEGER (2^53 - 1) -- would lose precision
    // if compared via Number() coercion.
    const older = "9007199254740991000";
    const newer = "9007199254740992000";
    expect(isNewerStatusId(newer, older)).toBe(true);
    expect(isNewerStatusId(older, newer)).toBe(false);
  });

  it("returns false for an equal status id", () => {
    expect(isNewerStatusId("123", "123")).toBe(false);
  });
});

describe("createCursorStore", () => {
  const store = createCursorStore(doc, TABLE_NAME);

  it("returns null when no cursor has been set", async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await store.getCursor("exampleauthor");
    expect(result).toBeNull();
  });

  it("returns the stored lastSeenStatusId", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { lastSeenStatusId: "1234567890" } });
    const result = await store.getCursor("exampleauthor");
    expect(result).toBe("1234567890");
  });

  it("normalizes the handle (case, leading @) when reading", async () => {
    ddbMock.on(GetCommand).resolves({});
    await store.getCursor("@ExampleAuthor");

    const call = ddbMock.commandCalls(GetCommand)[0];
    expect(call.args[0].input.Key).toEqual({ pk: "CURSOR#exampleauthor", sk: "STATE" });
  });

  it("writes the normalized handle and status id when setting a cursor", async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.setCursor("@ExampleAuthor", "1234567890");

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item).toMatchObject({
      pk: "CURSOR#exampleauthor",
      sk: "STATE",
      lastSeenStatusId: "1234567890",
    });
  });
});
