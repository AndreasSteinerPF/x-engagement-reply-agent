#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { XEngagementReplyAgentStack } from "../lib/x-engagement-reply-agent-stack";

// Mirrors scripts/invoke-local.ts's `node --env-file-if-exists=.env` behavior
// -- cdk synth/deploy is invoked via `npx ts-node` (see cdk.json's "app"),
// which can't take that Node CLI flag directly, so load it here instead.
// The stack reads Asana GIDs and settings.yaml-adjacent values from
// process.env at synth time via loadRuntimeEnv(), same as the real handler.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const app = new cdk.App();

new XEngagementReplyAgentStack(app, "XEngagementReplyAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
});
