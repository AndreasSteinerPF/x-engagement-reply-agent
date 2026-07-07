import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDraftingModel } from "./agent/bedrock-model";
import { createAsanaClient } from "./asana/client";
import { createAsanaDedupeCache } from "./asana/dedupe";
import { loadRuntimeEnv } from "./config/env";
import { resolveSecret } from "./config/resolve-secret";
import { loadSettings } from "./config/settings";
import { loadWatchlist } from "./config/watchlist";
import {
  createDryRunSideEffectGateway,
  createLiveSideEffectGateway,
  type SideEffectGateway,
} from "./effects/side-effect-gateway";
import { createCircuitBreaker } from "./mcp/circuit-breaker";
import { createInvestorMcpClient } from "./mcp/investors-mcp-client";
import { createLangSmithFacade } from "./observability/langsmith";
import { logRuntime } from "./observability/logger";
import { notifyCriticalFailure } from "./observability/notify-critical-failure";
import { runMonitor, type RunSummary } from "./orchestration/run-monitor";
import { loadPromptSet } from "./prompts/load-prompts";
import { createCursorStore } from "./state/cursor-store";
import { createDedupeStore } from "./state/dedupe-store";
import { createDynamoDocumentClient } from "./state/dynamo-client";
import { createRotationStore } from "./state/rotation-store";
import { createRunLock } from "./state/run-lock";
import { createRunSummaryStore } from "./state/run-summary-store";
import { createXClient } from "./x/client";

export type HandlerEvent = {
  dryRun?: boolean;
};

const RUN_LOCK_TTL_SECONDS = 600;

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function emptySummary(runKey: string, dryRun: boolean): RunSummary {
  const now = new Date().toISOString();
  return {
    runKey,
    startedAt: now,
    finishedAt: now,
    dryRun,
    authorsPolled: 0,
    postsFetched: 0,
    newPostsProcessed: 0,
    asanaTasksCreated: 0,
    posts: [],
  };
}

/**
 * The real Lambda entrypoint: constructs every real client/store from
 * config and environment, then delegates to runMonitor. A critical failure
 * (an error escaping runMonitor entirely) pages on-call via
 * notifyCriticalFailure -- structurally wired now, pointed at a TODO for
 * the real PagerDuty Events API v2 call. Cost-prediction gate,
 * Powertools-based structured logging (beyond the minimal
 * src/observability/logger.ts stub), and the EventBridge Scheduler trigger
 * itself still land in Phase 6.
 */
export async function handler(event: HandlerEvent = {}): Promise<RunSummary> {
  const dryRun = event.dryRun ?? false;
  const runKey = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 10)}`;

  const env = loadRuntimeEnv();
  const settings = loadSettings();
  const watchlist = loadWatchlist();
  const promptSet = loadPromptSet();

  const xBearerToken = await resolveSecret({
    plainValue: env.X_BEARER_TOKEN,
    secretArn: env.X_BEARER_TOKEN_SECRET_ARN,
    region: env.AWS_REGION,
  });
  const xClient = createXClient({ bearerToken: requireEnv(xBearerToken, "X_BEARER_TOKEN") });
  const mcpClient = createInvestorMcpClient();
  const breaker = createCircuitBreaker(3);
  const model = createDraftingModel(settings.modelId, env);
  const langsmith = await createLangSmithFacade(env);

  const tableName = requireEnv(env.STATE_TABLE_NAME, "STATE_TABLE_NAME");
  const dynamoDoc = createDynamoDocumentClient(new DynamoDBClient({ region: env.AWS_REGION }));
  const cursorStore = createCursorStore(dynamoDoc, tableName);
  const dedupeStore = createDedupeStore(dynamoDoc, tableName, settings.dedupeTtlDays);
  const runSummaryStore = createRunSummaryStore(dynamoDoc, tableName);
  const rotationStore = createRotationStore(dynamoDoc, tableName);
  const runLock = createRunLock(dynamoDoc, tableName);

  let gateway: SideEffectGateway;
  if (dryRun) {
    gateway = createDryRunSideEffectGateway();
  } else {
    const asanaAccessToken = await resolveSecret({
      plainValue: env.ASANA_ACCESS_TOKEN,
      secretArn: env.ASANA_ACCESS_TOKEN_SECRET_ARN,
      region: env.AWS_REGION,
    });
    const asanaClient = createAsanaClient({
      accessToken: requireEnv(asanaAccessToken, "ASANA_ACCESS_TOKEN"),
    });
    const dedupeCache = createAsanaDedupeCache({ asanaClient });
    gateway = createLiveSideEffectGateway({
      asanaClient,
      dedupeCache,
      env,
      cursorStore,
      dedupeStore,
      runSummaryStore,
      rotationStore,
    });
  }

  let lockAcquired = false;
  if (!dryRun) {
    const lockResult = await runLock.acquireLock({
      owner: runKey,
      ttlSeconds: RUN_LOCK_TTL_SECONDS,
    });
    if (!lockResult.acquired) {
      logRuntime({
        level: "warn",
        message: "Monitor run skipped: another run holds the lock",
        runKey,
        lockOwner: lockResult.owner,
        lockExpiresAt: lockResult.expiresAt,
      });
      return emptySummary(runKey, dryRun);
    }
    lockAcquired = true;
  }

  try {
    const summary = await runMonitor({
      xClient,
      mcpClient,
      breaker,
      model,
      langsmith,
      cursorStore,
      dedupeStore,
      rotationStore,
      gateway,
      settings,
      promptSet,
      watchlist,
      runKey,
    });

    await gateway.writeRunSummary(summary);
    logRuntime({
      level: "info",
      message: "Monitor run complete",
      runKey,
      authorsPolled: summary.authorsPolled,
      postsFetched: summary.postsFetched,
      newPostsProcessed: summary.newPostsProcessed,
      asanaTasksCreated: summary.asanaTasksCreated,
    });
    return summary;
  } catch (error) {
    notifyCriticalFailure({ runKey, error });
    throw error;
  } finally {
    await langsmith.flush();
    await mcpClient.close();
    if (lockAcquired) {
      await runLock.releaseLock(runKey);
    }
  }
}
