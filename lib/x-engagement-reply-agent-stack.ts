import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

const PROJECT_NAME = "x-engagement-reply-agent";

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
    });

    stateTable.grantReadWriteData(monitorHandler);
  }
}
