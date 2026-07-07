#!/usr/bin/env node
import * as fs from "node:fs";

/**
 * Cross-platform recursive directory copy used by the Lambda bundling
 * commandHooks in lib/x-engagement-reply-agent-stack.ts. NodejsFunction only
 * bundles imported JS by default, not config/*.yaml or prompts/**\/*.md, so
 * those have to be copied into the output directory explicitly. A plain
 * `cp -r` shell command doesn't work identically on Windows (where local,
 * non-Docker bundling runs the hook via cmd.exe, which has no `cp`), so this
 * uses Node's fs.cpSync instead -- correct on every platform CDK might
 * bundle on.
 *
 * Usage: tsx copy-lambda-assets.ts <src> <dest>
 */
const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error("Usage: tsx copy-lambda-assets.ts <src> <dest>");
  process.exit(1);
}

fs.cpSync(src, dest, { recursive: true });
