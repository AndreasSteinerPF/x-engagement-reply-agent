import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { RunSummary } from "../orchestration/run-monitor";

export type RunSummaryStore = {
  writeRunSummary: (summary: RunSummary) => Promise<void>;
};

const SECONDS_PER_DAY = 86_400;
const DEFAULT_TTL_DAYS = 90;

/**
 * Persists a completed run's structured summary (authors polled, posts
 * fetched, per-post outcomes) so it can be queried after the fact --
 * completing the "persist runtime state externally for ... run summaries"
 * acceptance criterion. GSI1 (gsi1pk/gsi1sk) supports a "recent runs"
 * query without rebuilding the legacy admin/reporting UI (out of scope).
 */
export function createRunSummaryStore(
  doc: DynamoDBDocumentClient,
  tableName: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): RunSummaryStore {
  async function writeRunSummary(summary: RunSummary): Promise<void> {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `RUN#${summary.runKey}`,
          sk: "SUMMARY",
          gsi1pk: "RUNSUMMARY",
          gsi1sk: `${summary.startedAt}#${summary.runKey}`,
          ...summary,
          ttl: nowEpochSeconds + ttlDays * SECONDS_PER_DAY,
        },
      }),
    );
  }

  return { writeRunSummary };
}
