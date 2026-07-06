import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type ProcessedPostOutcome = "ingested" | "skipped" | "tasked" | "failed";

export type MarkProcessedParams = {
  sourceUri: string;
  statusId: string;
  outcome: ProcessedPostOutcome;
  asanaTaskGid?: string;
};

export type DedupeStore = {
  hasProcessed: (sourceUri: string, statusId: string) => Promise<boolean>;
  markProcessed: (params: MarkProcessedParams) => Promise<void>;
};

const SECONDS_PER_DAY = 86_400;

/**
 * Tracks already-processed posts by (sourceUri, statusId) so repeated runs
 * never double-ingest, double-draft, or double-task the same post. TTL is a
 * generous operational window, not a correctness guarantee -- Asana's own
 * existing-task lookup (Phase 5) remains the source of truth for "already
 * tasked" once an entry expires or state is lost.
 */
export function createDedupeStore(
  doc: DynamoDBDocumentClient,
  tableName: string,
  ttlDays: number,
): DedupeStore {
  async function hasProcessed(sourceUri: string, statusId: string): Promise<boolean> {
    const result = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `POST#${sourceUri}`, sk: `STATUS#${statusId}` },
      }),
    );
    return result.Item !== undefined;
  }

  async function markProcessed(params: MarkProcessedParams): Promise<void> {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `POST#${params.sourceUri}`,
          sk: `STATUS#${params.statusId}`,
          outcome: params.outcome,
          asanaTaskGid: params.asanaTaskGid,
          ts: new Date().toISOString(),
          ttl: nowEpochSeconds + ttlDays * SECONDS_PER_DAY,
        },
      }),
    );
  }

  return { hasProcessed, markProcessed };
}
