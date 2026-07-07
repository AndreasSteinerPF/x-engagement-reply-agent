import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type RotationStore = {
  getCursorIndex: () => Promise<number>;
  setCursorIndex: (index: number) => Promise<void>;
};

/**
 * Persists the single round-robin index used to select the next batch of
 * authors to poll across runs (see run-monitor.ts). One row for the whole
 * watchlist, not per-handle -- matches the reference implementation's
 * single `state.cursor` integer (investors-mcp's monitor-x route).
 */
export function createRotationStore(doc: DynamoDBDocumentClient, tableName: string): RotationStore {
  async function getCursorIndex(): Promise<number> {
    const result = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: "RUN#ROTATION", sk: "STATE" },
      }),
    );
    const cursorIndex = result.Item?.cursorIndex;
    return typeof cursorIndex === "number" ? cursorIndex : 0;
  }

  async function setCursorIndex(index: number): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: "RUN#ROTATION",
          sk: "STATE",
          cursorIndex: index,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  return { getCursorIndex, setCursorIndex };
}
