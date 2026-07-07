import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

const LOCK_KEY = { pk: "LOCK#MONITOR", sk: "STATE" };

export type AcquireLockParams = {
  owner: string;
  ttlSeconds: number;
};

export type RunLockResult =
  { acquired: true } | { acquired: false; reason: "lock-busy"; owner: string; expiresAt: string };

export type RunLock = {
  acquireLock: (params: AcquireLockParams) => Promise<RunLockResult>;
  releaseLock: (owner: string) => Promise<void>;
};

/**
 * A single-item conditional-write lock so overlapping scheduled invocations
 * (a slow run still executing when the next tick fires) never process the
 * same batch concurrently. Not a general-purpose distributed lock -- this
 * agent only ever needs one lock, for one resource (the monitor run).
 */
export function createRunLock(doc: DynamoDBDocumentClient, tableName: string): RunLock {
  async function acquireLock(params: AcquireLockParams): Promise<RunLockResult> {
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

    try {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...LOCK_KEY,
            owner: params.owner,
            startedAt: nowIso,
            expiresAt: expiresAtIso,
            ttl: Math.floor(Date.now() / 1000) + params.ttlSeconds,
          },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": nowIso },
        }),
      );
      return { acquired: true };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const existing = await doc.send(new GetCommand({ TableName: tableName, Key: LOCK_KEY }));
        return {
          acquired: false,
          reason: "lock-busy",
          owner: String(existing.Item?.owner ?? "unknown"),
          expiresAt: String(existing.Item?.expiresAt ?? ""),
        };
      }
      throw error;
    }
  }

  async function releaseLock(owner: string): Promise<void> {
    try {
      await doc.send(
        new DeleteCommand({
          TableName: tableName,
          Key: LOCK_KEY,
          // "owner" is a DynamoDB reserved keyword -- must go through
          // ExpressionAttributeNames rather than appear literally in the
          // ConditionExpression (only ever caught by a real DynamoDB call;
          // aws-sdk-client-mock's unit tests don't validate expression
          // syntax against the reserved-word list).
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        // Someone else already re-acquired the lock (e.g. it expired under
        // us) -- releasing our stale ownership is a safe no-op, not a bug.
        return;
      }
      throw error;
    }
  }

  return { acquireLock, releaseLock };
}
