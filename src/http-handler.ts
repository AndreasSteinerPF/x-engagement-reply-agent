import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadRuntimeEnv } from "./config/env";
import { resolveSecret } from "./config/resolve-secret";
import { runHandlerCore } from "./handler";
import { logRuntime } from "./observability/logger";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-api-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// APIGatewayProxyResultV2 is a `string | {...}` union (Function URLs also
// accept a bare string as the whole response body) -- this handler always
// returns the object form, so a concrete type here is both simpler to test
// against and still structurally assignable wherever APIGatewayProxyResultV2
// is expected.
type HttpResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function jsonResponse(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

// Served on GET requests -- a self-contained page (no separate hosting) so
// an evaluator can click a "Run now" button in a browser instead of
// crafting a curl request. The API key is deliberately NOT baked into this
// page (it's served publicly to anyone with the URL) -- the evaluator
// pastes in the key they were given out-of-band, same security property as
// the curl-based flow, just with a friendlier UI matching
// scripts/demo-server.ts's local tool.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>X Engagement Reply Agent -- Evaluator Trigger</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    max-width: 760px; margin: 3rem auto; padding: 0 1.5rem;
    color: #1a1a1a; background: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #14161a; }
    .card, input[type="text"] { background: #1d2025 !important; border-color: #2c3036 !important; color: #e8e8e8; }
    a { color: #7db8ff; }
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .subtitle { color: #6b7280; margin-top: 0; margin-bottom: 1.5rem; font-size: 0.95rem; }
  label.field { display: block; margin: 1rem 0 0.3rem; font-weight: 600; font-size: 0.9rem; }
  input[type="text"] {
    width: 100%; padding: 0.6rem 0.75rem; font-size: 0.95rem; border-radius: 8px;
    border: 1px solid #d1d5db; box-sizing: border-box;
  }
  .controls { display: flex; align-items: center; gap: 1.25rem; margin: 1.5rem 0; }
  label.checkbox { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
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
  ul.events li { padding: 0.6rem 0; border-bottom: 1px solid rgba(128,128,128,0.15); line-height: 1.5; }
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
<p class="subtitle">On-demand trigger for the real deployed Lambda -- no AWS credentials needed. Dry run works for anyone with this URL; a real (live) run needs an API key.</p>

<label class="field" for="apiKey">API key (only needed for a live run -- leave blank for dry run)</label>
<input type="text" id="apiKey" placeholder="Only required when Dry run is unchecked" autocomplete="off" />

<div class="controls">
  <button id="runBtn">Run now</button>
  <label class="checkbox"><input type="checkbox" id="dryRun" checked /> Dry run (no real Asana/DynamoDB writes)</label>
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
  const apiKeyInput = document.getElementById("apiKey");
  const runBtn = document.getElementById("runBtn");
  const dryRunBox = document.getElementById("dryRun");
  const statusEl = document.getElementById("status");
  const eventsEl = document.getElementById("events");
  const rawEl = document.getElementById("raw");

  function describeSkip(reason) {
    if (!reason) return "skipped";
    if (reason === "dry-run")
      return "reached the tasking gate; dry-run mode suppressed the write (match quality isn't visible in dry-run -- rerun live to see real scores in the Asana task notes)";
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
        const matchLabel = post.subtaskCount > 0
          ? "matched " + post.subtaskCount + " approval subtask(s) worth of content"
          : "created for manual triage (no article cleared the recommendation threshold)";
        li.innerHTML =
          "✅ New post from <strong>@" + post.authorHandle + "</strong> -- Asana task " + matchLabel + ".<br/>" +
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
    const apiKey = apiKeyInput.value.trim();
    if (!dryRunBox.checked && !apiKey) {
      statusEl.textContent = "A live run needs the API key -- enter it, or check Dry run.";
      statusEl.className = "status-line error";
      return;
    }

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
      const url = window.location.origin + window.location.pathname + "?dryRun=" + dryRunBox.checked;
      const response = await fetch(url, { method: "POST", headers: { "x-api-key": apiKey } });
      const body = await response.json();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      if (!response.ok) {
        statusEl.textContent = "Failed after " + elapsed + "s";
        statusEl.className = "status-line error";
        eventsEl.innerHTML = "";
        const li = document.createElement("li");
        li.textContent = (body && body.error) || "Unknown error -- see raw response below.";
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

function htmlResponse(): HttpResult {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
    body: PAGE_HTML,
  };
}

/**
 * Public Lambda Function URL -- anyone with the URL can independently
 * trigger and verify a dry run of the deployed monitor with zero
 * credentials at all, no AWS access needed. A single rotatable API key is
 * required only for privileged (real-write) runs -- a smaller, easier-to-
 * revoke trust surface than a standing IAM identity inside the AWS
 * account's trust boundary (see docs/deployment.md).
 *
 * GET serves a small clickable HTML page (safe, no side effects, no key
 * required just to view it); POST with the default dry run also needs no
 * key (fully public, zero side effects); POST with `dryRun=false` (real
 * X/Bedrock/Asana writes) requires the key. Shares the exact same pipeline
 * as the EventBridge-scheduled `handler` via runHandlerCore() -- this file
 * only adds HTTP framing,
 * the UI, and the API-key check.
 */
export async function httpHandler(event: APIGatewayProxyEventV2): Promise<HttpResult> {
  const method = event.requestContext.http.method;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (method === "GET") {
    return htmlResponse();
  }

  // Defaults to dry-run (safe) unless the caller explicitly opts into a
  // real run via ?dryRun=false, mirroring scripts/demo-server.ts's own
  // default-safe behavior.
  const dryRunParam = event.queryStringParameters?.dryRun;
  const dryRun = dryRunParam === undefined ? true : dryRunParam !== "false";

  // Only a PRIVILEGED run (dryRun: false -- real X/Bedrock/Asana writes)
  // requires the API key. The default dry run is fully public: anyone with
  // the URL can independently verify the pipeline actually polls, matches,
  // and drafts, with zero side effects and zero credential needed -- this
  // is deliberately the same split the competing candidate's own
  // evaluator-facing dashboard uses (privileged actions gated, safe
  // read-only/dry-run actions open).
  if (!dryRun) {
    const env = loadRuntimeEnv();
    const expectedKey = await resolveSecret({
      secretArn: env.EVALUATOR_API_KEY_SECRET_ARN,
      region: env.AWS_REGION,
    });

    // API Gateway v2 / Function URL payload format always lowercases
    // header names, so only the lowercase key needs to be checked.
    const providedKey = event.headers["x-api-key"];
    if (!expectedKey || !providedKey || providedKey !== expectedKey) {
      logRuntime({
        level: "warn",
        message: "Rejected privileged Function URL invocation: missing or invalid x-api-key",
      });
      return jsonResponse(401, {
        error: "Unauthorized -- a live (non-dry-run) run requires the x-api-key header",
      });
    }
  }

  try {
    const summary = await runHandlerCore(dryRun);
    return jsonResponse(200, summary);
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
