import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type CursorStore = {
  getCursor: (handle: string) => Promise<string | null>;
  setCursor: (handle: string, statusId: string) => Promise<void>;
};

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * X/Twitter status IDs are 64-bit snowflake integers as strings -- larger
 * than Number.MAX_SAFE_INTEGER, so they must be compared as BigInt, never
 * coerced through Number() or compared as plain strings of differing length.
 */
export function isNewerStatusId(candidate: string, current: string | null): boolean {
  if (!current) return true;
  return BigInt(candidate) > BigInt(current);
}

export function createCursorStore(doc: DynamoDBDocumentClient, tableName: string): CursorStore {
  async function getCursor(handle: string): Promise<string | null> {
    const result = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `CURSOR#${normalizeHandle(handle)}`, sk: "STATE" },
      }),
    );
    const lastSeenStatusId = result.Item?.lastSeenStatusId;
    return typeof lastSeenStatusId === "string" ? lastSeenStatusId : null;
  }

  async function setCursor(handle: string, statusId: string): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `CURSOR#${normalizeHandle(handle)}`,
          sk: "STATE",
          lastSeenStatusId: statusId,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  return { getCursor, setCursor };
}
