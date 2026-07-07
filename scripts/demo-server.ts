#!/usr/bin/env node
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import * as http from "node:http";
import { loadRuntimeEnv } from "../src/config/env";

/**
 * Local-only demo trigger for the REAL deployed Lambda -- distinct from
 * scripts/invoke-local.ts, which runs the pipeline in-process against
 * fixtures/live flags without ever touching the deployed function. This is
 * for demoing the actual deployed system on demand, since the real
 * EventBridge Schedule is intentionally set to a rare 24h interval (and
 * disabled by default) rather than firing every couple of minutes -- see
 * config/settings.yaml and lib/x-engagement-reply-agent-stack.ts.
 *
 * Binds to localhost only; your AWS credentials never leave this machine,
 * and the browser page never talks to AWS directly -- it only calls this
 * local server, which does the real lambda:InvokeFunction call server-side.
 *
 * Usage: npm run demo:trigger
 */
const FUNCTION_NAME = "x-engagement-reply-agent-monitor";
const PORT = 4173;
const HOST = "127.0.0.1";

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>X Engagement Reply Agent -- Manual Trigger</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  label { display: flex; align-items: center; gap: 0.5rem; margin: 1rem 0; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer; }
  button:disabled { cursor: wait; opacity: 0.6; }
  pre { background: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .status { font-weight: 600; margin-top: 1rem; }
  .status.error { color: #b00020; }
  .status.ok { color: #1a7a1a; }
</style>
</head>
<body>
<h1>X Engagement Reply Agent -- Manual Trigger</h1>
<p>Invokes the real deployed Lambda (<code>${FUNCTION_NAME}</code>) on demand, instead of waiting for the 24h schedule.</p>
<label><input type="checkbox" id="dryRun" checked /> Dry run (no real Asana/DynamoDB writes)</label>
<button id="runBtn">Run now</button>
<p id="status"></p>
<pre id="result"></pre>
<script>
  const runBtn = document.getElementById("runBtn");
  const dryRunBox = document.getElementById("dryRun");
  const statusEl = document.getElementById("status");
  const resultEl = document.getElementById("result");

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    statusEl.textContent = "Running...";
    statusEl.className = "status";
    resultEl.textContent = "";
    try {
      const response = await fetch("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: dryRunBox.checked }),
      });
      const body = await response.json();
      if (!response.ok) {
        statusEl.textContent = "Failed";
        statusEl.className = "status error";
      } else {
        statusEl.textContent = "Done";
        statusEl.className = "status ok";
      }
      resultEl.textContent = JSON.stringify(body, null, 2);
    } catch (error) {
      statusEl.textContent = "Failed";
      statusEl.className = "status error";
      resultEl.textContent = String(error);
    } finally {
      runBtn.disabled = false;
    }
  });
</script>
</body>
</html>
`;

async function invokeReal(dryRun: boolean): Promise<{ status: number; body: unknown }> {
  const env = loadRuntimeEnv();
  const client = new LambdaClient({ region: env.AWS_REGION });

  const response = await client.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ dryRun })),
    }),
  );

  const payloadText = response.Payload ? Buffer.from(response.Payload).toString("utf8") : "";
  const parsed: unknown = payloadText ? JSON.parse(payloadText) : null;

  if (response.FunctionError) {
    return { status: 502, body: { functionError: response.FunctionError, details: parsed } };
  }
  return { status: 200, body: parsed };
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ dryRun?: boolean }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as { dryRun?: boolean };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
    return;
  }

  if (req.method === "POST" && req.url === "/run") {
    readJsonBody(req)
      .then((body) => invokeReal(body.dryRun ?? true))
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      })
      .catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[demo-server] Listening on http://${HOST}:${PORT} -- open this in your browser.`);
  console.log(`[demo-server] Invokes the real deployed Lambda: ${FUNCTION_NAME}`);
});
