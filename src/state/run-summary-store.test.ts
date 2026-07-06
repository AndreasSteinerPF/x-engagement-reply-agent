import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../orchestration/run-monitor";
import { createRunSummaryStore } from "./run-summary-store";

const TABLE_NAME = "test-table";
const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SUMMARY: RunSummary = {
  runKey: "run-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  dryRun: false,
  authorsPolled: 1,
  postsFetched: 2,
  newPostsProcessed: 2,
  asanaTasksCreated: 1,
  posts: [],
};

beforeEach(() => {
  ddbMock.reset();
});

describe("createRunSummaryStore", () => {
  it("writes the summary keyed by RUN#<runKey> with a GSI for recent-run queries", async () => {
    ddbMock.on(PutCommand).resolves({});
    const store = createRunSummaryStore(doc, TABLE_NAME);

    await store.writeRunSummary(SUMMARY);

    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe("RUN#run-1");
    expect(item.sk).toBe("SUMMARY");
    expect(item.gsi1pk).toBe("RUNSUMMARY");
    expect(item.gsi1sk).toBe("2026-01-01T00:00:00.000Z#run-1");
    expect(item.asanaTasksCreated).toBe(1);
  });

  it("sets a TTL derived from ttlDays", async () => {
    ddbMock.on(PutCommand).resolves({});
    const store = createRunSummaryStore(doc, TABLE_NAME, 30);
    const beforeSeconds = Math.floor(Date.now() / 1000);

    await store.writeRunSummary(SUMMARY);

    const call = ddbMock.commandCalls(PutCommand)[0];
    const item = call.args[0].input.Item as Record<string, unknown>;
    expect(item.ttl as number).toBeGreaterThanOrEqual(beforeSeconds + 30 * 86_400);
  });
});
