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
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    max-width: 760px; margin: 3rem auto; padding: 0 1.5rem;
    color: #1a1a1a; background: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #14161a; }
    .card { background: #1d2025 !important; border-color: #2c3036 !important; }
    a { color: #7db8ff; }
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .subtitle { color: #6b7280; margin-top: 0; margin-bottom: 1.5rem; font-size: 0.95rem; }
  .controls { display: flex; align-items: center; gap: 1.25rem; margin: 1.5rem 0; }
  label { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
  button {
    font-size: 1rem; padding: 0.65rem 1.4rem; cursor: pointer; border: none;
    border-radius: 8px; background: #2563eb; color: white; font-weight: 600;
  }
  button:disabled { cursor: wait; opacity: 0.55; }
  .card {
    background: #f8f9fb; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 1.25rem 1.5rem; margin-top: 1rem;
  }
  .status-line { font-weight: 700; font-size: 1.05rem; margin: 0 0 0.75rem; }
  .status-line.running { color: #b45309; }
  .status-line.ok { color: #15803d; }
  .status-line.error { color: #b00020; }
  ul.events { list-style: none; padding: 0; margin: 0; }
  ul.events li {
    padding: 0.6rem 0; border-bottom: 1px solid rgba(128,128,128,0.15);
    line-height: 1.5;
  }
  ul.events li:last-child { border-bottom: none; }
  .btn-link {
    display: inline-block; margin-top: 0.4rem; padding: 0.3rem 0.75rem;
    border-radius: 6px; background: #2563eb; color: white !important;
    text-decoration: none; font-size: 0.85rem; font-weight: 600;
  }
  details { margin-top: 1.25rem; }
  summary { cursor: pointer; color: #6b7280; font-size: 0.9rem; }
  pre {
    background: #11131a; color: #d4d4d4; padding: 1rem; border-radius: 6px;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    font-size: 0.8rem; margin-top: 0.5rem;
  }
</style>
</head>
<body>
<h1>X Engagement Reply Agent</h1>
<p class="subtitle">Manual trigger for the real deployed Lambda (<code>${FUNCTION_NAME}</code>) -- no waiting on the schedule.</p>
<div class="controls">
  <button id="runBtn">Run now</button>
  <label><input type="checkbox" id="dryRun" /> Dry run (no real Asana/DynamoDB writes)</label>
</div>
<div class="card">
  <p class="status-line" id="status">Ready.</p>
  <ul class="events" id="events"></ul>
</div>
<details>
  <summary>Raw response (JSON)</summary>
  <pre id="raw"></pre>
</details>
<script>
  const runBtn = document.getElementById("runBtn");
  const dryRunBox = document.getElementById("dryRun");
  const statusEl = document.getElementById("status");
  const eventsEl = document.getElementById("events");
  const rawEl = document.getElementById("raw");

  function describeSkip(reason) {
    if (!reason) return "skipped";
    if (reason === "dry-run") return "matched, but dry-run mode suppressed the Asana write";
    if (reason === "already-processed" || reason === "already-tasked-existing-task")
      return "already handled in a previous run (no duplicate created)";
    if (reason === "user-not-found") return "handle could not be resolved on X";
    if (reason.startsWith("below-similarity-threshold"))
      return "did not clear the similarity threshold -- no parent task";
    if (reason.startsWith("rate-limited")) return "X API rate limit hit -- run stopped early";
    return reason;
  }

  function renderEvents(body) {
    eventsEl.innerHTML = "";
    const summary = document.createElement("li");
    const modeLabel = body.dryRun ? "DRY RUN" : "LIVE";
    summary.innerHTML =
      "<strong>" + modeLabel + "</strong> -- " + body.authorsPolled + " author(s) polled, " +
      body.postsFetched + " post(s) fetched, " + body.newPostsProcessed + " evaluated.";
    eventsEl.appendChild(summary);

    for (const post of body.posts || []) {
      const li = document.createElement("li");
      if (post.outcome === "tasked") {
        li.innerHTML =
          "✅ New post from <strong>@" + post.authorHandle + "</strong> matched the corpus -- " +
          "Asana task created with " + post.subtaskCount + " approval subtask(s).<br/>" +
          "<a class=\\"btn-link\\" href=\\"" + post.sourceUri + "\\" target=\\"_blank\\">View source post</a> " +
          "<a class=\\"btn-link\\" href=\\"" + post.asanaTaskUrl + "\\" target=\\"_blank\\">Open Asana task</a>";
      } else if (post.sourceUri) {
        li.innerHTML =
          "⏭️ Post from <strong>@" + post.authorHandle + "</strong>: " + describeSkip(post.skipReason) +
          ".<br/><a class=\\"btn-link\\" href=\\"" + post.sourceUri + "\\" target=\\"_blank\\">View source post</a>";
      } else {
        li.textContent = "⚠️ Could not poll @" + post.authorHandle + ": " + describeSkip(post.skipReason);
      }
      eventsEl.appendChild(li);
    }

    if ((body.posts || []).length === 0) {
      const li = document.createElement("li");
      li.textContent = "No posts to evaluate this run.";
      eventsEl.appendChild(li);
    }
  }

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    const startedAt = Date.now();
    statusEl.textContent = "Running... 0s";
    statusEl.className = "status-line running";
    eventsEl.innerHTML = "";
    rawEl.textContent = "";

    const ticker = setInterval(() => {
      statusEl.textContent = "Running... " + Math.floor((Date.now() - startedAt) / 1000) + "s";
    }, 1000);

    try {
      const response = await fetch("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: dryRunBox.checked }),
      });
      const body = await response.json();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      if (!response.ok) {
        statusEl.textContent = "Failed after " + elapsed + "s";
        statusEl.className = "status-line error";
        eventsEl.innerHTML = "";
        const li = document.createElement("li");
        li.textContent = (body && body.functionError) || (body && body.error) || "Unknown error -- see raw response below.";
        eventsEl.appendChild(li);
      } else {
        statusEl.textContent = "Done in " + elapsed + "s";
        statusEl.className = "status-line ok";
        renderEvents(body);
      }
      rawEl.textContent = JSON.stringify(body, null, 2);
    } catch (error) {
      statusEl.textContent = "Failed";
      statusEl.className = "status-line error";
      rawEl.textContent = String(error);
    } finally {
      clearInterval(ticker);
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
