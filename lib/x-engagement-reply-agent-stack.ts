import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { loadRuntimeEnv } from "../src/config/env";
import { loadSettings } from "../src/config/settings";

const PROJECT_NAME = "x-engagement-reply-agent";

// Operator creates these via `aws secretsmanager create-secret` before
// deploying (see docs/deployment.md's "Deploy steps") -- CDK only
// references them by name, it never creates a secret containing a real
// candidate-supplied credential in the CloudFormation template.
const ASANA_ACCESS_TOKEN_SECRET_NAME = `${PROJECT_NAME}/asana-access-token`;
const X_BEARER_TOKEN_SECRET_NAME = `${PROJECT_NAME}/x-bearer-token`;
const LANGSMITH_API_KEY_SECRET_NAME = `${PROJECT_NAME}/langsmith-api-key`;
// Distinct from the three above: this one is *meant* to be shared with an
// evaluator (it gates src/http-handler.ts's Function URL, not a candidate
// credential), so its value is documented directly in docs/deployment.md
// rather than kept private.
const EVALUATOR_API_KEY_SECRET_NAME = `${PROJECT_NAME}/evaluator-api-key`;

/**
 * Builds the Lambda's plaintext environment variables from process.env
 * (loaded from .env by bin/x-engagement-reply-agent.ts, same file
 * scripts/invoke-local.ts reads) -- omitting anything unset rather than
 * writing empty-string env vars. Secrets (Asana/X/LangSmith tokens) are
 * deliberately excluded here; those are wired separately as
 * Secrets-Manager-ARN env vars, never as plaintext values.
 */
function nonSecretEnvironment(env: ReturnType<typeof loadRuntimeEnv>): Record<string, string> {
  const candidates: Record<string, string | undefined> = {
    ASANA_PROJECT_GID: env.ASANA_PROJECT_GID,
    ASANA_WORKSPACE_GID: env.ASANA_WORKSPACE_GID,
    ASANA_SECTION_GID: env.ASANA_SECTION_GID,
    ASANA_ASSIGNEE_GID: env.ASANA_ASSIGNEE_GID,
    ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID: env.ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID,
    ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID: env.ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID,
    ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID: env.ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID,
    ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID:
      env.ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID,
    ASANA_EXISTING_TASK_DEDUPE_ENABLED: env.ASANA_EXISTING_TASK_DEDUPE_ENABLED,
    LANGSMITH_PROJECT: env.LANGSMITH_PROJECT,
    LANGSMITH_TRACING: env.LANGSMITH_TRACING,
    LANGSMITH_ENDPOINT: env.LANGSMITH_ENDPOINT,
  };

  return Object.fromEntries(
    Object.entries(candidates).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
    ),
  );
}

// Bedrock's cross-region inference profile ID prefixes (see the "Inference
// profiles" page in the Bedrock console) -- a modelId starting with one of
// these routes to the underlying foundation model in one of several
// regions, so the IAM policy needs both the profile ARN (in this stack's
// own account/region) and a region-wildcarded foundation-model ARN, not
// just a single region's foundation-model ARN.
const BEDROCK_CROSS_REGION_PREFIXES = ["us.", "eu.", "apac.", "global."];

/**
 * Builds the least-privilege bedrock:InvokeModel resource ARNs for
 * whichever modelId is configured in config/settings.yaml, so the IAM
 * policy stays correct automatically if the model is ever changed there
 * (e.g. the Claude 3.5 Haiku -> Haiku 4.5 migration this project already
 * went through once when 3.5 Haiku was retired from the Bedrock catalog).
 */
function bedrockModelInvokeArns(stack: cdk.Stack, modelId: string): string[] {
  const crossRegionPrefix = BEDROCK_CROSS_REGION_PREFIXES.find((prefix) =>
    modelId.startsWith(prefix),
  );

  if (!crossRegionPrefix) {
    return [`arn:aws:bedrock:${stack.region}::foundation-model/${modelId}`];
  }

  const foundationModelId = modelId.slice(crossRegionPrefix.length);
  return [
    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
    `arn:aws:bedrock:*::foundation-model/${foundationModelId}`,
  ];
}

/**
 * Full Phase 6 stack: the monitor Lambda, its DynamoDB state table,
 * Secrets Manager references, Bedrock IAM, and an EventBridge Scheduler
 * trigger with a DLQ + alarm on failed invocations. See
 * docs/implementation-plan.md for the target architecture and
 * docs/deployment.md for the deploy runbook (secrets to create first, the
 * SCHEDULE_ENABLED safety toggle, etc.).
 */
export class XEngagementReplyAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      tags: {
        project_name: PROJECT_NAME,
        ...props?.tags,
      },
    });

    const stateTable = new dynamodb.TableV2(this, "StateTable", {
      tableName: `${PROJECT_NAME}-state`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const monitorLogGroup = new logs.LogGroup(this, "MonitorLogGroup", {
      logGroupName: `/aws/lambda/${PROJECT_NAME}-monitor`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const asanaAccessTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AsanaAccessTokenSecret",
      ASANA_ACCESS_TOKEN_SECRET_NAME,
    );
    const xBearerTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "XBearerTokenSecret",
      X_BEARER_TOKEN_SECRET_NAME,
    );
    const langsmithApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "LangsmithApiKeySecret",
      LANGSMITH_API_KEY_SECRET_NAME,
    );
    const evaluatorApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EvaluatorApiKeySecret",
      EVALUATOR_API_KEY_SECRET_NAME,
    );

    const runtimeEnv = loadRuntimeEnv(process.env);

    const copyAssetsScript = path.join(__dirname, "..", "scripts", "copy-lambda-assets.ts");

    // Shared by both Lambdas below -- config/*.yaml and prompts/**/*.md are
    // read from disk at runtime (src/config/watchlist.ts, settings.ts,
    // src/prompts/load-prompts.ts all default to `process.cwd()`, the
    // Lambda package root), so NodejsFunction's default JS-only bundling
    // has to be supplemented with an explicit copy step. See
    // scripts/copy-lambda-assets.ts for why this uses a script (via `npx
    // tsx`) rather than a raw `cp -r` shell command (Windows local
    // bundling has no `cp`).
    const assetBundling: lambda.NodejsFunctionProps["bundling"] = {
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (inputDir, outputDir) => [
          `npx tsx "${copyAssetsScript}" "${path.join(inputDir, "config")}" "${path.join(outputDir, "config")}"`,
          `npx tsx "${copyAssetsScript}" "${path.join(inputDir, "prompts")}" "${path.join(outputDir, "prompts")}"`,
        ],
      },
    };

    const sharedEnvironment = {
      STATE_TABLE_NAME: stateTable.tableName,
      ASANA_ACCESS_TOKEN_SECRET_ARN: asanaAccessTokenSecret.secretArn,
      X_BEARER_TOKEN_SECRET_ARN: xBearerTokenSecret.secretArn,
      LANGSMITH_API_KEY_SECRET_ARN: langsmithApiKeySecret.secretArn,
      ...nonSecretEnvironment(runtimeEnv),
    };

    const monitorHandler = new lambda.NodejsFunction(this, "MonitorHandler", {
      functionName: `${PROJECT_NAME}-monitor`,
      entry: path.join(__dirname, "..", "src", "handler.ts"),
      handler: "handler",
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      logGroup: monitorLogGroup,
      environment: sharedEnvironment,
      bundling: assetBundling,
    });

    stateTable.grantReadWriteData(monitorHandler);
    asanaAccessTokenSecret.grantRead(monitorHandler);
    xBearerTokenSecret.grantRead(monitorHandler);
    langsmithApiKeySecret.grantRead(monitorHandler);

    const settings = loadSettings();
    monitorHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: bedrockModelInvokeArns(this, settings.modelId),
      }),
    );

    // Evaluator/on-demand trigger: an API-key-gated Function URL fronting
    // the same pipeline (via src/handler.ts's runHandlerCore, shared with
    // the EventBridge-scheduled monitorHandler above). Deliberately a
    // rotatable API key rather than handing out scoped IAM credentials --
    // easier to revoke, no AWS CLI setup needed on the caller's end, and a
    // smaller trust surface than a standing identity inside this account.
    // See docs/deployment.md for the exact key value and usage.
    const httpTriggerLogGroup = new logs.LogGroup(this, "HttpTriggerLogGroup", {
      logGroupName: `/aws/lambda/${PROJECT_NAME}-http-trigger`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const httpTriggerHandler = new lambda.NodejsFunction(this, "HttpTriggerHandler", {
      functionName: `${PROJECT_NAME}-http-trigger`,
      entry: path.join(__dirname, "..", "src", "http-handler.ts"),
      handler: "httpHandler",
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      logGroup: httpTriggerLogGroup,
      environment: {
        ...sharedEnvironment,
        EVALUATOR_API_KEY_SECRET_ARN: evaluatorApiKeySecret.secretArn,
      },
      bundling: assetBundling,
    });

    stateTable.grantReadWriteData(httpTriggerHandler);
    asanaAccessTokenSecret.grantRead(httpTriggerHandler);
    xBearerTokenSecret.grantRead(httpTriggerHandler);
    langsmithApiKeySecret.grantRead(httpTriggerHandler);
    evaluatorApiKeySecret.grantRead(httpTriggerHandler);
    httpTriggerHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: bedrockModelInvokeArns(this, settings.modelId),
      }),
    );

    const httpTriggerUrl = httpTriggerHandler.addFunctionUrl({
      authType: cdk.aws_lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["content-type", "x-api-key"],
        allowedMethods: [cdk.aws_lambda.HttpMethod.GET, cdk.aws_lambda.HttpMethod.POST],
      },
    });

    new cdk.CfnOutput(this, "HttpTriggerUrl", {
      value: httpTriggerUrl.url,
      description:
        "Evaluator on-demand trigger. POST here with header x-api-key: <see docs/deployment.md>. " +
        "Add ?dryRun=false to create real Asana tasks; defaults to a safe dry run.",
    });

    // Catches failed *invocations* of the schedule's target (e.g. the
    // Scheduler service itself couldn't call the Lambda after retries --
    // permissions, throttling) -- distinct from a failed *execution* of the
    // handler's own logic, which notify-critical-failure.ts already covers
    // via handler.ts's catch block. One DLQ, one alarm on it (the company's
    // one-alarm-per-DLQ pattern) -- no SNS/PagerDuty action attached, since
    // no real on-call system exists for this take-home (see
    // docs/deployment.md's observability note).
    const scheduleDlq = new sqs.Queue(this, "MonitorScheduleDlq", {
      queueName: `${PROJECT_NAME}-schedule-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    new cloudwatch.Alarm(this, "MonitorScheduleDlqAlarm", {
      alarmDescription:
        "EventBridge Scheduler failed to invoke the monitor Lambda after retries. " +
        "Production would page on-call via this alarm's SNS action; see docs/deployment.md.",
      metric: scheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const schedulerRole = new iam.Role(this, "MonitorSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    monitorHandler.grantInvoke(schedulerRole);
    scheduleDlq.grantSendMessages(schedulerRole);

    // Defaults to DISABLED: a fresh deploy shouldn't silently start polling
    // real X/Bedrock/Asana on a live schedule before the operator has
    // deliberately confirmed the poll interval and flipped this on (see
    // docs/deployment.md's "Deploy steps"). Set SCHEDULE_ENABLED=true when
    // running cdk deploy to enable it.
    const scheduleEnabled = process.env.SCHEDULE_ENABLED === "true";

    new scheduler.CfnSchedule(this, "MonitorSchedule", {
      name: `${PROJECT_NAME}-monitor-schedule`,
      description: `Polls the X watchlist every ${settings.pollIntervalMinutes} minute(s), per config/settings.yaml.`,
      state: scheduleEnabled ? "ENABLED" : "DISABLED",
      scheduleExpression: `rate(${settings.pollIntervalMinutes} minute${settings.pollIntervalMinutes === 1 ? "" : "s"})`,
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: monitorHandler.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({}),
        deadLetterConfig: { arn: scheduleDlq.queueArn },
      },
    });
  }
}
