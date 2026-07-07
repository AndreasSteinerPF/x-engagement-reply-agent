import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { loadSettings } from "../src/config/settings";

const PROJECT_NAME = "x-engagement-reply-agent";

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
 * Phase 0 scaffold: a single Lambda + a single DynamoDB state table.
 * EventBridge Scheduler, DLQ, alarms, and Secrets Manager entries are wired
 * in Phase 6 once the runtime orchestration (Phase 5) exists to invoke.
 * See docs/implementation-plan.md for the full target architecture.
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

    const copyAssetsScript = path.join(__dirname, "..", "scripts", "copy-lambda-assets.ts");

    const monitorHandler = new lambda.NodejsFunction(this, "MonitorHandler", {
      functionName: `${PROJECT_NAME}-monitor`,
      entry: path.join(__dirname, "..", "src", "handler.ts"),
      handler: "handler",
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      logGroup: monitorLogGroup,
      environment: {
        STATE_TABLE_NAME: stateTable.tableName,
      },
      // NodejsFunction only bundles imported JS by default -- config/*.yaml
      // and prompts/**/*.md are read from disk at runtime
      // (src/config/watchlist.ts, src/config/settings.ts,
      // src/prompts/load-prompts.ts all default to `process.cwd()`, which is
      // the Lambda package root, `/var/task`), so they have to be copied
      // into the bundle explicitly. See scripts/copy-lambda-assets.ts for
      // why this uses a script (via `npx tsx`) rather than a raw `cp -r`
      // shell command (Windows local bundling has no `cp`).
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `npx tsx "${copyAssetsScript}" "${path.join(inputDir, "config")}" "${path.join(outputDir, "config")}"`,
            `npx tsx "${copyAssetsScript}" "${path.join(inputDir, "prompts")}" "${path.join(outputDir, "prompts")}"`,
          ],
        },
      },
    });

    stateTable.grantReadWriteData(monitorHandler);

    const settings = loadSettings();
    monitorHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: bedrockModelInvokeArns(this, settings.modelId),
      }),
    );
  }
}
