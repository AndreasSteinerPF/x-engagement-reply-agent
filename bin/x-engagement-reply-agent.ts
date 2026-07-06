#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { XEngagementReplyAgentStack } from "../lib/x-engagement-reply-agent-stack";

const app = new cdk.App();

new XEngagementReplyAgentStack(app, "XEngagementReplyAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
});
