# X Engagement Reply Agent — Implementation Plan

## Context

This is a job-application take-home (`x-engagement-reply-agent/README.md`). The
legacy `investors-mcp` Next.js monolith already runs this pipeline in production
against a database-managed config; the milestone is to extract it into a
standalone, code-configured agent that fits the target company's
(`soofi-xyz-team-kit`) AWS/TypeScript/CDK conventions, while preserving the
human-in-the-loop behavior (draft + task, never auto-post).

Two things make this non-trivial to just "port": (1) no single existing company
agent pattern fits — this is a scheduled poller with outbound Asana writes, not
an inbound Asana-chat-bot, so we deliberately borrow parts of two skills rather
than following either's full playbook (see `CLAUDE.md`); (2) you're new to
AWS/Lambda/CDK, coming from .NET — the plan below is ordered so each phase is a
small, independently-verifiable step, and includes a terminology bridge at the
end.

Full architecture research (reference implementation function-by-function,
company golden-path rules, MCP tool contract) was already done and is captured
below — this is the synthesized, buildable plan, not a re-derivation.

## Recommended approach

### Repo layout

```
x-engagement-reply-agent/
├── bin/x-engagement-reply-agent.ts        # CDK app entry (region us-east-2, project_name tag)
├── lib/x-engagement-reply-agent-stack.ts  # Lambda + DynamoDB + EventBridge Scheduler + DLQ + alarm + secrets
├── src/
│   ├── handler.ts                         # Lambda entry: cost gate → lock → runMonitor → notifyCriticalFailure on throw
│   ├── orchestration/run-monitor.ts       # pure-ish orchestrator, unit-testable with fakes
│   ├── config/{env,settings,watchlist}.ts # Zod-validated env + config/*.yaml loaders
│   ├── prompts/load-prompts.ts            # system.md / constraints.md / replies/NN-*.md loader
│   ├── x/{client,parse-post,interaction}.ts   # X API v2 client, tweet→post parsing, reply/quote classification
│   ├── mcp/investors-mcp-client.ts        # queryInvestorContent/listInvestorContent via MCP SDK
│   ├── matching/similarity-gating.ts      # threshold math (two distinct thresholds, see below)
│   ├── agent/{bedrock-model,bedrock-prompt-cache,draft-replies,schemas}.ts
│   ├── asana/{client,dedupe,payloads,assignee-rule}.ts
│   ├── state/{dynamo-client,cursor-store,dedupe-store,run-lock,run-summary-store}.ts
│   ├── effects/side-effect-gateway.ts     # single dry-run/live seam for ALL external writes
│   ├── cost/predict-run-cost.ts           # cost-prediction gate, first step of every invocation
│   └── observability/{logger,tracer,metrics,notify-critical-failure,langsmith}.ts
├── config/{watchlist.yaml,settings.yaml}
├── prompts/{system.md,constraints.md,replies/01-...06-*.md}   # 6 slots for the demo
├── scripts/invoke-local.ts                # local single-author dry-run harness, no deploy needed
├── test/fixtures/                         # extend examples/reference/fixtures/synthetic-post-and-reply.json
├── docs/{config-schema.md,deployment.md}  # new, alongside existing reference-architecture.md
├── justfile                               # format, lint, type-check, test, build, deploy (integrate-ci-cd contract)
└── .github/workflows/ci.yml               # self-contained equivalent of ci-cd-dev/prod.yml, see CI/CD note below
```

Tests are colocated (`foo.ts`/`foo.test.ts`) per module.

### CI/CD: follow `integrate-ci-cd`'s contract, adapted for no company org access

Every builder agent in the kit (`meowth`, `lucario`, the `build-ai-agents` agents)
wires CI/CD the same way, via the `integrate-ci-cd` skill: a root `justfile`
with exactly six recipes (`format`, `lint`, `type-check`, `test`, `build`,
`deploy`), plus two GitHub Actions caller workflows
(`ci-cd-dev.yml` on PR-to-`main`, `ci-cd-prod.yml` on push-to-`main`) that each
invoke a shared reusable workflow at
`Spring-Oaks-Capital-LLC/github-workflows` over AWS OIDC. Add the `justfile`
with the same six recipes — it's the right shape and costs nothing. The caller
workflows can't be ported as-is: that shared-workflow repo is company-private,
and this assignment repo lives under `prismteam-ai`, not
`Spring-Oaks-Capital-LLC`, so there's no access and no OIDC role to assume.
Ship a self-contained `.github/workflows/ci.yml` that runs the same six
recipes in the same order (`format → lint → type-check → test → build →
deploy-dry-run`, with real `cdk deploy` gated behind a manual/approved job so
CI never deploys to a candidate's personal AWS account unattended), and note
in `docs/deployment.md` that a real company repo would call the shared
`ci-cd-dev.yml`/`ci-cd-prod.yml` workflows per `integrate-ci-cd` instead.

### Execution shape: EventBridge Scheduler → one Lambda (not Step Functions)

The reference implementation itself is a single serverless function with an
internal time budget that persists partial progress and resumes from cursor —
same shape here. Watchlist is a handful of authors; work per item is I/O-bound
(HTTP calls), not heavy compute. Step Functions Distributed Map's value (massive
parallel fan-out, redrive bookkeeping) doesn't pay for itself at this scale and
is one more AWS primitive to learn for no operational benefit. Keep
`orchestration/run-monitor.ts`'s per-item logic isolated from Lambda-only APIs
so a future migration to Distributed Map, if the watchlist grows to hundreds of
authors, is a wiring change, not a rewrite.

**Checked against the closest counter-example in the kit and still holds:**
`meowth` (the Cursor spend-limit approval agent) explicitly refuses to collapse
into a plain scheduled Lambda "even though the per-run candidate count is
small," because its flow needs `WaitForTaskToken` — the state machine pauses
mid-execution for up to days until a human completes an Asana approval task,
then *resumes* into a follow-up step that re-validates and applies the change.
That genuine pause-and-resume need is what forces Step Functions there. This
agent has no equivalent: once the parent task and subtasks are created, this
agent's work for that post is finished — nothing needs to wake back up when a
human approves or posts the reply, there is no callback and no "apply the
approved action" step to resume into. Since the thing that forces Step
Functions in `meowth` doesn't exist here, the single-Lambda + EventBridge
Scheduler shape stands.

- EventBridge Scheduler invokes the Lambda every `pollIntervalMinutes`.
- Handler enforces poll-interval and pause checks itself (reads last-run state), so a manual `force: true` invoke still works for demos.
- Lambda timeout set generously; orchestrator enforces its own shorter internal `runBudgetMs` so it always has time to persist a clean partial-run summary before AWS would kill it.
- Idempotency without Distributed Map redrive: every post is keyed by `sourceUri + statusId` in DynamoDB *before* any side effect, and the per-handle cursor only advances after that post is fully persisted — so a retry after a crash re-fetches but never double-processes.
- Cost-prediction gate is the literal first line of `handler.ts`: estimate Bedrock cost for the run against a configured `costCeilingUsdPerRun`; if exceeded, abort with `skipReason: "cost-ceiling-exceeded"`, log/alert at WARN (not a page — this is an expected gate), and let the next tick retry.
- Throttling is in-process (`p-limit`/`p-throttle`) around the X client (respect rate-limit headers, stop processing remaining authors on 429 rather than crashing) and around Bedrock calls (bounded concurrency ~3-4). **Implemented (post-Phase-5 audit):** `runMonitor` catches `XRateLimitError` specifically, stops the author loop immediately (rather than continuing to the next author, which would just hit the same global rate limit again), and surfaces `RunSummary.stoppedEarlyReason: "rate-limited"`. Bedrock concurrency limiting was already implemented in Phase 4 (`src/agent/draft-replies.ts`, `p-limit`).
- **Implemented (post-Phase-5 audit):** first-ever poll for a handle (no cursor yet) is bounded to `backfillHours` via X's `start_time` param (`src/x/client.ts`'s `FetchRecentPostsOptions.startTime`), rather than pulling a handle's entire timeline. This field was already validated in `config/settings.ts` but had never actually been read anywhere -- a real correctness gap (not just an observability one), since an unbounded first run against a long-tenured account could ingest far more history than the documented 24-hour default window intends.
- DLQ: give the EventBridge Scheduler target a `deadLetterConfig` (SQS), then apply the company's one-alarm-per-DLQ pattern to it — gets a real DLQ + self-resolving alarm even in a single-Lambda design.
- PagerDuty/Lexicon/Main Dashboard: implement the structural seam only — `notifyCriticalFailure()` logs ERROR with structured context and a `// TODO production: wire PagerDuty Events API v2` comment. No real account access exists for a take-home; document this explicitly in `docs/deployment.md` rather than silently skipping observability. **Implemented (post-Phase-5 audit):** `src/observability/notify-critical-failure.ts`, called from `handler.ts`'s catch block for any error escaping `runMonitor` entirely (as opposed to the per-post/per-author failures `runMonitor` already isolates and records in the run summary). The cost-prediction gate remains genuinely deferred to Phase 6 proper -- unlike the other items here, it needs real design work (it can't actually be "the first line of `handler.ts`" as originally sketched, since you can't estimate Bedrock cost before matching has told you how many drafts a run needs; it belongs after matching, before drafting, and needs a per-token cost table for whatever model is configured) rather than a quick bolt-on.

### State (DynamoDB, single table)

| Item | pk | sk | Attrs | TTL |
|---|---|---|---|---|
| Per-handle cursor | `CURSOR#<handle>` | `STATE` | `lastSeenStatusId`, `updatedAt` | none |
| Batch rotation | `RUN#ROTATION` | `STATE` | `cursorIndex` | none |
| Processed-post dedupe | `POST#<sourceUri>` | `STATUS#<statusId>` | `outcome`, `asanaTaskGid?`, `ts` | 90d (configurable) |
| Run lock | `LOCK#MONITOR` | `STATE` | `owner`, `expiresAt` | lock TTL |
| Run summary | `RUN#<runId>` | `SUMMARY` | structured JSON | 60-90d |

GSI on run summaries (`RUNSUMMARY` / `<startedAtIso>#<runId>`) for a "recent runs"
query without rebuilding the legacy admin/reporting UI (explicitly out of scope).

### X API integration

- **Pricing model (verified against `docs.x.com/x-api/getting-started/pricing`, checked 2026-07-06):** X API moved to **pay-per-use with no monthly minimum and no subscription tiers** — the old flat-fee Free/Basic($200/mo)/Pro tiers are gone for new signups (legacy Basic/Pro subscribers were migrated off as of June 2026). Current rates: **$0.005 per post read**, $0.015 per post created ($0.20 if it contains a link — irrelevant here, this agent never posts). A 1000x-cheaper "owned reads" rate ($0.001) exists but only applies to an app's *own* data, not to polling other authors' timelines, so it doesn't help this use case. For a demo-scale watchlist (3-6 authors, `since_id`-based polling so most ticks return zero new posts), expected cost is a few dollars total, not the ~$200/mo this plan originally assumed under the old tier model — a meaningfully lower barrier than first flagged. **Still unverified:** whether an empty poll response (no new posts) still incurs a per-request charge or only per-resource-returned — confirm the exact billing granularity in the live Developer Console before running the demo continuously over days.
- Resolve the whole watchlist to user IDs once per run: `GET /2/users/by?usernames=...`.
- New-post detection per handle: `GET /2/users/:id/tweets?since_id=<cursor>&expansions=referenced_tweets.id,referenced_tweets.id.author_id&tweet.fields=article,note_tweet,referenced_tweets,...`. Use `since_id` directly (cheaper than fetch-N-and-diff); cursor = max status ID seen (Twitter/X IDs are monotonically increasing).
- Referenced originals not inlined in `includes` → batch-resolve via `GET /2/tweets?ids=...`.
- Reply/quote/repost/original classification: `referenced_tweets[].type` + `in_reply_to_user_id`, with a text-heuristic fallback only when metadata is absent.
- **Scope reduction (flagged):** do not port the reference's GraphQL-scraping/bearer-token-discovery fallback for long-form X "Articles" — it's undocumented-API territory with ToS risk, disproportionate for this milestone. Use the documented `article` field and `note_tweet.text`, falling back to plain `text`; if none suffice, record `articleEnrichment: "unavailable"` explicitly rather than silently degrading.
- First-ever run per handle (no cursor): bounded backfill window (`backfillHours`, default 24), not full history.
- 429 handling: stop processing remaining authors this run (already-processed ones keep their persisted progress); alert only on N consecutive rate-limited runs, not per-429.
- **Response validation (added during a Phase 0-3 self-audit):** every X API response is validated against a Zod schema (`src/x/types.ts`) before use, not blindly type-cast — per `apply-engineering-guidelines`' CRITICAL-impact "External System Response Validation" rule. A 2xx status with a shape that's silently drifted (or an unexpected error body) throws loudly at the client boundary instead of corrupting data downstream. Same treatment applied to the MCP client's `queryInvestorContent` response.

### MCP client

Use `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` against
`https://investors-mcp.vercel.app/mcp` rather than hand-rolling JSON-RPC — the
transport's session/SSE handling is easy to get subtly wrong by hand.
`queryInvestorContent({ query: postText, author: "Soofi Safavi", contentType: "article", segmentType: "article_full", topK })`.
No credentials needed today; isolate the call behind this one client module so
adding a read-token header later is a one-line change. Wrap every call in a
timeout; on failure, skip just that post (`skip-reason: mcp-query-failed`) and
continue the batch. Add a per-run circuit breaker (stop calling MCP after N
consecutive failures in one run) so a downed dependency can't burn the whole
Lambda time budget on retries. `addInvestorParagraph` (write) has **no code
path in this repo at all** — not gated by dry-run, simply never implemented.

**Verified discrepancy (2026-07-06):** the README's required example uses
`topK: 40`, but the live server rejects anything above 20 (`isError: true`,
non-JSON body) — confirmed by testing `topK: 20` (succeeds) then `topK: 40`
(fails) against the same live endpoint. The MCP client/matching layer clamps
the value actually sent to 20 regardless of what `defaultTopK` is configured
to; see `docs/config-schema.md` for the full writeup. Caught by actually
running Phase 3's live verification step against the real server rather than
trusting the written spec — worth remembering as a general lesson for the
rest of this build.

### LLM drafting

- Amazon Bedrock via `@ai-sdk/amazon-bedrock`, wrapped with prompt caching (port the kit's `implementation-bedrock-prompt-caching.md` pattern near-verbatim — cache the first system message + last non-system message, log cache read/write tokens).
- **Note:** the example `settings.yaml`'s `modelId: openai/gpt-4.1-mini` is a legacy AI-gateway ID — must become a real Bedrock model ID or inference profile enabled in the target account/region. Call this out in `docs/config-schema.md` so it isn't missed.
- `@ai-sdk/amazon-bedrock` uses AWS SDK v3 internally, but application code never imports `@aws-sdk/client-bedrock-runtime` directly — all calls go through `generateObject`/`generateText`, satisfying the "Vercel AI SDK only" rule. Worth a one-line code comment so a reviewer doesn't flag the transitive dependency by mistake.
- **One `generateObject` call per (matched article × prompt-slot file)** rather than the reference's single batched call per article. Deliberate departure, chosen for: the most literal reading of "one reply per prompt file" and "adding a 6th prompt file = one more subtask"; a clean LangSmith trace per prompt file; simpler per-call Zod schema/retry. Acceptable cost/latency at this scale with bounded concurrency (~3-4 concurrent calls). Note the reference's batched approach as a future optimization if the prompt-slot/watchlist count grows a lot.
- LangSmith facade wraps every call, `sessionId = runKey` (this agent's stand-in for `thread.id`, since there's no chat), tagged with post/article/prompt metadata — satisfies "observable, traceable LLM runs." `flush()` before every return path in `handler.ts`, including error paths.
- Output schema: draft text ≤ configured char limit, a `quotedPhrase` that must be a verifiable (near-)substring of the matched article excerpt (grounding), ends in a question unless the prompt file opts out. On validation failure, retry once with a stricter prompt; on second failure, record a visible placeholder (`"LLM generation failed for <slot>: <reason>"`) — never silently drop a slot.
- **Character limit needs a machine-readable source.** `prompts/constraints.md`'s "Maximum of 280 characters" is prose for the LLM, not something code can safely regex out of a Markdown file. Added `maxReplyCharacters` to `config/settings.yaml` (default 280) as the field validation actually checks against.
- **`DraftReplyOutcome` includes `promptText` (found during a post-Phase-4 self-audit).** The README's acceptance criteria specify the structured output must contain "prompt label, prompt text, draft reply, why recommended" verbatim — the first cut of `DraftReplyOutcome` had label/draft/why-recommended but not the prompt file's own instruction text, which would have forced Phase 5's Asana builder to re-correlate back to the original `ReplyPromptSlot` list by `promptIndex` instead of the outcome being self-contained. Fixed by adding `promptText: slot.content` to both the success and failure/placeholder branches.

**Three real corrections made while implementing this phase, verified against the actual installed packages rather than assumed from the kit's rule docs (same "verify against the real thing" discipline as the topK discovery in Phase 3):**

1. **`tsconfig.json` moved from `node16`/`node16` to `nodenext`/`nodenext`.** The Vercel AI SDK (`ai`) ships ESM-only. Node 22 can `require()` an ESM-only package natively now (a newer interop capability), but TypeScript's `node16` resolution mode predates that behavior and rejected the import at type-check time. `nodenext` tracks current Node behavior and resolved it with no other changes needed — deliberately *not* a full project-wide ESM migration (`"type": "module"` + extension rewrites across every relative import), which would have been a much larger, unnecessary blast radius for what turned out to be a narrow TypeScript-resolution-mode gap.
2. **The kit's `implementation-bedrock-prompt-caching.md` reference targets `LanguageModelV3`; the installed `@ai-sdk/amazon-bedrock` (5.x) returns `LanguageModelV4`.** Confirmed by reading the installed package's own `.d.ts` files. The cache strategy and usage-token field names (`usage.inputTokens.cacheRead`/`cacheWrite`) are unchanged between the two versions — only the `specificationVersion` literal and middleware type differ. Ported with `v4` throughout.
3. **`wrapAISDK`'s actual signature is `(ai, baseLsConfig?)`, not `(ai, { client })` as a distinct second parameter** — but `client` turns out to be a valid property *of* `baseLsConfig` (inherited from `RunTreeConfig`), so `wrapAISDK(ai, { client })` still works, just not for the reason the rule doc's shape implies. Confirmed by reading `langsmith`'s installed `.d.ts`.
4. **The LangSmith facade wraps `generateObject`, not `ToolLoopAgent`.** The kit's rule doc is written for the inbound Asana-chat-agent pattern (multi-step tool loops); this agent does single-shot structured generation per (article × prompt slot) with no tools, per the "Phases 3/4/7 don't apply" note in `CLAUDE.md`. Every other rule (resolve the API key from Secrets Manager and cache it, pass the same `Client` to `wrapAISDK` and `flush()`, group traces by session, degrade gracefully instead of failing the invocation) is unchanged.

### Asana integration

Plain REST (`https://app.asana.com/api/1.0/...`, Bearer PAT) — no Chat SDK, no
webhook, since this agent only writes tasks and never listens for Asana events.

- Parent task: `Draft response: <author> - <header>`; notes carry source/article URIs, both thresholds applied, best-match raw score, top qualifying articles. `asanaTaskSimilarityThreshold` (best raw score across candidates; `0` = always create if other checks pass) gates parent-task creation. Created into `ASANA_PROJECT_GID`, optionally scoped to `ASANA_WORKSPACE_GID` on the create payload; if `ASANA_SECTION_GID` is configured, a second `POST /sections/{gid}/addTask` call places the task in that section immediately after creation (matches the reference exactly — this satisfies the README's explicit "configurable Asana project, section, workspace" requirement, which is easy to miss since only `ASANA_PROJECT_GID` shows up in the most-quoted parts of the reference).
- One approval subtask per (article × prompt-slot) clearing `articleSimilarityThreshold`; `resource_subtype: "approval"`, `approval_status: "pending"`; notes carry prompt label/text, draft, why-recommended, and the X compose-intent link.
- Compose link: `https://twitter.com/intent/tweet?in_reply_to=<statusId>&text=<urlencoded draft>` (keep `twitter.com` — matches the reference and is the long-standing working intent URL).
- Threshold-based assignee/due-date: if a qualifying article clears `articleSimilarityThreshold` and `ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID` is configured, set that assignee + `due_on = today`; else fall back to `ASANA_ASSIGNEE_GID` if configured.
- Similarity custom fields: separate parent/subtask GIDs (`ASANA_TASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID`, `ASANA_SUBTASK_SIMILARITY_SCORE_CUSTOM_FIELD_GID`), each falling back to a shared `ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID` if the specific one isn't set; omit `custom_fields` entirely if neither resolves.
- Existing-task dedupe: DynamoDB entry is a fast-path; a live, capped/paginated Asana project-task scan (matching `sourceUri`/status ID in name+notes) remains the source of truth for first-deploy/state-loss cases — same pragmatic (not infinitely scalable) approach the reference uses.
- Excluded authors (e.g. the corpus author's own posts): `excludedTaskAuthors: string[]` in `settings.yaml`, not hardcoded.

**Implemented in `src/asana/`** (`client.ts`, `dedupe.ts`, `links.ts`, `custom-fields.ts`, `notes.ts`, `create-asana-tasking.ts`), matching every bullet above, plus Zod-validated responses (same "External System Response Validation" discipline as the X/MCP clients).

**A design decision worth flagging explicitly: an MCP failure does NOT automatically skip Asana tasking.** The first draft of `src/orchestration/run-monitor.ts` treated any MCP match failure as an immediate full skip. Re-reading the reference's `createAsanaTask` more closely (specifically its `asanaTaskSimilarityThreshold > 0` branch) showed it only skips entirely when the threshold requires a similarity score to gate on; at `threshold = 0` ("always create if other checks pass"), it still creates a parent task with minimal notes even when the corpus match failed, so a human can manually triage the post. Fixed to match: an MCP failure is treated as "no similarity data" (`topArticles: []`) and falls through to the normal threshold gate, which naturally reproduces the reference's behavior via `meetsAsanaTaskThreshold(null, threshold)` — no special-casing needed. The run summary still distinguishes this case as outcome `"failed"` (a dependency error) rather than `"skipped"` (a normal business-rule outcome) when nothing ends up created, satisfying the acceptance criteria's `"ingested, skipped, tasked, failed"` outcome list.

### Config/prompts

- `config/watchlist.yaml`, `config/settings.yaml` validated with Zod at load time — a bad value throws (fails CI/deploy loudly) rather than silently clamping like the legacy DB-backed version did.
- Widen `defaultTopK` bound to 1-100 (legacy schema capped at 20; the required MCP integration example itself uses `topK: 40`) — flagged deliberate schema change.
- New fields beyond the legacy schema: `dedupeTtlDays`, `backfillHours`, `costCeilingUsdPerRun`, `excludedTaskAuthors`.
- `prompts/replies/NN-slug.md`: glob + sort by numeric prefix → `promptIndex`; `promptLabel` from a leading `# Prompt N — Title` heading or the filename slug. No hard cap on slot count. No hot-reload — a prompt change requires `cdk deploy`, which matches the assignment's own wording.
- Document the full schema (including the legacy-vs-new diffs above) in `docs/config-schema.md`.

### Dry-run mode

One seam, `src/effects/side-effect-gateway.ts`, selected once per run:
MCP reads always execute for real in every mode (read-only by construction).
Live mode does real DynamoDB writes and real Asana POSTs. Dry-run mode makes
**zero** network writes — not even the Asana existing-task scan, so it's a
true no-op safe to run against production Asana data at any time — and returns
synthetic results (`{ created: false, reason: "dry-run" }`) while still
populating the full structured output (matches, scores, all drafted replies).
X API reads still execute in dry-run (needed to detect posts); only state
persistence and Asana writes are suppressed.

### Observability seams (concrete files)

Powertools `Logger`/`Tracer`/`Metrics` in `src/observability/{logger,tracer,metrics}.ts`;
business metrics (`AuthorsPolled`, `PostsProcessed`, `AsanaTasksCreated`,
`CostPredicted`, etc.); `notify-critical-failure.ts` stub; `langsmith.ts` facade.
`docs/deployment.md` explicitly documents what's stubbed (PagerDuty routing,
Lexicon metric registration, Main Dashboard widgets) vs. wired, since a
take-home candidate has no real access to those internal systems.

### Testing & local verification

- Vitest unit tests per module (config validation, prompt loader, tweet parsing/classification, MCP client incl. circuit breaker, similarity gating boundaries, prompt-cache middleware, draft schema/retry/placeholder behavior, Asana payload/notes/link builders, dedupe-store/run-lock via `aws-sdk-client-mock`).
- **Not yet implemented, deliberately deferred:** local DynamoDB integration tests (docker-compose + DynamoDB Local, tables created/torn down per run, skipped gracefully when no endpoint is configured). `aws-sdk-client-mock` only proves "our code calls PutCommand/GetCommand with these parameters" -- it can't catch a bad `ConditionExpression` (run-lock.ts's conditional-write lock), a key-schema mistake, or whether a real query against the run-summary GSI (`gsi1pk`/`gsi1sk`) actually works, since no test issues a query against it today. Deferred rather than built-and-unverified: this needs Docker Desktop running to build *and prove correct* in the same "verify against the real thing" way every other integration point in this project has been -- writing it without ever running it against a real DynamoDB Local would risk shipping exactly the kind of subtle bug (e.g. a GSI missing an attribute definition) this test tier exists to catch.
- **Implemented:** an integration test suite (`src/orchestration/run-monitor.test.ts`, 11 cases) running the real `runMonitor()` end-to-end against faked X/MCP/Bedrock/Asana clients — happy path, referenced-original resolution, dedupe short-circuit, MCP-failure gating (both the "skip" and "still task at threshold 0" branches), threshold filtering, dry-run, per-author failure isolation, and inactive-author skipping.
- `cdk synth` test asserting least-privilege IAM (table scoped, Bedrock invoke, Secrets read scoped to specific secrets) — still open, deferred to Phase 6 alongside the rest of the IAM/deploy work.
- **Implemented:** `scripts/invoke-local.ts` now calls the *real* `runMonitor()` (the same function `handler.ts` uses), not a parallel hand-rolled reimplementation — `--author <handle> --dry-run [--live-mcp] [--live-llm] [--live-asana] [--persist] [--reset]`. X is always a fixture (no candidate X credentials exist yet); MCP/Bedrock/Asana each independently opt into their real implementation per flag, with graceful fallback to a fixture/dry-run when the flag is passed without the matching credentials configured. `--force-retask` (a dedupe-bypass for the "edit a prompt, see the updated draft" demo scenario) is not yet implemented — deferred to Phase 7 demo polish, since it only matters once a demo watchlist/history exists.
- **Cursor/dedupe state defaults to in-memory (fresh per invocation, never touches real DynamoDB), with an opt-in persistent alternative.** The default `Map` resets on every process exit, so two separate `invoke-local` runs could never prove idempotency ("run it twice, no duplicate task") without a real DynamoDB table -- a real verification gap, since that's one of the more load-bearing behaviors the assignment asks for. `--persist` (`src/state/file-state-store.ts`) backs cursor/dedupe with a JSON file instead, so state survives between invocations; `--reset` clears it for a fresh demo. Local-only; the real Lambda handler never touches this file. Since the dry-run gateway makes *zero* writes by design (cursor/dedupe included), proving this needed an actual write path that doesn't require real Asana credentials -- `createFixtureAsanaWithRealStateGateway` in `invoke-local.ts` returns a labeled-fixture Asana result while still writing real cursor/dedupe state, so `--persist` demonstrates the full skip-on-repeat behavior end to end with zero external credentials of any kind.
- Each Required Demo Scenario in the README maps directly to one of: a live `invoke-local` run + Asana inspection, a fixture-driven dry-run, or a config/prompt edit + redeploy + re-run — see the README's Required Demo Scenarios section as the checklist to walk at the end.

### Phased build order

0. **Scaffold** — CDK skeleton, `justfile` (six `integrate-ci-cd` recipes), self-contained `.github/workflows/ci.yml` running them in order, empty test suite green. *Verify: `just format lint type-check test build`, CI green.*
1. **Config + prompts** — real `config/`/`prompts/` files (6 slots), Zod schemas, `docs/config-schema.md`. *Verify: `vitest run src/config src/prompts`.*
2. **X polling + dedupe** — X client, cursor/dedupe/run-lock state, DynamoDB table. *Verify: fixture-driven unit tests + `invoke-local` (mocked X) detects a synthetic reply's referenced original.*
3. **MCP matching** — MCP client, similarity gating. *Verify: `invoke-local --live-mcp` against a real post returns plausible scores from the live hosted MCP.*
4. **LLM drafting + tracing** — Bedrock + prompt cache + LangSmith. *Verify: `invoke-local --dry-run --live-llm`, confirm a trace session in LangSmith grouped by run key with one child run per prompt slot.*
5. **Asana tasking** — Asana client, side-effect gateway, full orchestration wiring, `handler.ts`. *Verify: live run against a real sandbox Asana project creates the expected parent+subtasks; a repeat run creates zero duplicates.* **Done.** All of `src/asana/`, `src/effects/side-effect-gateway.ts`, `src/orchestration/run-monitor.ts`, and the real `src/handler.ts` are implemented and tested (259 tests passing). The real sandbox-Asana verification itself is **not yet done** — this take-home has no Asana PAT/sandbox project configured, so `--live-asana` has only been verified to gracefully fall back to dry-run when credentials are absent, the same "reaches the real dependency and fails for the right reason" verification used for `--live-llm` in Phase 4.
6. **Observability & deploy** — Powertools, cost gate, EventBridge Scheduler + DLQ + alarm, Secrets Manager, `docs/deployment.md` complete (including the `integrate-ci-cd` note: justfile shape kept, shared caller workflows documented but not wired due to no `Spring-Oaks-Capital-LLC` org access). *Verify: `just deploy` clean, a scheduled tick produces a run summary, a forced failure drains through the DLQ alarm.*
7. **Demo polish** — 3+ real watched authors, 6 finalized prompts, full walk-through of every Required Demo Scenario. *Verify: each scenario executed once against the deployed stack.*

## For a .NET/Azure background — rough equivalents

| AWS/company-kit concept | .NET/Azure equivalent (rough) |
|---|---|
| AWS Lambda | Azure Function (consumption/isolated worker) |
| AWS CDK (TypeScript) | Bicep/ARM, but you write imperative TS classes that *synthesize* to CloudFormation — closer to writing a Pulumi program than to declarative YAML |
| `cdk deploy` | `az deployment group create` / a Bicep `what-if` + apply |
| EventBridge Scheduler | Azure Scheduler / a Timer-triggered Function |
| DynamoDB | Azure Table Storage / Cosmos DB (key-value/partition-sort model, not relational) |
| SQS (DLQ) | Azure Storage Queue or Service Bus dead-letter queue |
| CloudWatch Logs/Alarms | Azure Monitor / Log Analytics + Alert Rules |
| X-Ray tracing | Application Insights distributed tracing |
| Secrets Manager | Azure Key Vault |
| Powertools (Logger/Tracer/Metrics) | Serilog + Application Insights SDK, roughly |
| Vercel AI SDK (`ai` package) | Closest .NET analog is Microsoft.Extensions.AI / Semantic Kernel's model-agnostic abstraction — same idea: one API surface, swappable model provider underneath |
| Amazon Bedrock | Azure AI Foundry / OpenAI-on-Azure — a hosted-model gateway, here specifically fronting Anthropic/other models on AWS |
| Zod | FluentValidation / data annotations, but also doubles as the TS *type* (schema-as-source-of-truth, no separate DTO class) |
| Vitest | xUnit/NUnit, but test-file-colocated and much faster (no separate test project) |
| npm workspaces / `package.json` scripts | csproj + `dotnet` CLI targets, roughly |

## Verification (overall)

- After each phase, run its own listed `vitest` subset before moving on — don't let failures accumulate across phases.
- Before declaring the milestone done, walk every Required Demo Scenario in `README.md` against the actually-deployed stack (not just unit tests) — the assignment's Definition of Done explicitly requires demonstrated behavior, not just passing tests.
- Confirm dry-run truly makes zero Asana/DynamoDB writes by running it against the real sandbox Asana project and checking nothing changed there.
- Confirm the two thresholds are not conflated anywhere in code review: `asanaTaskSimilarityThreshold` (parent task gate) vs `articleSimilarityThreshold` (per-article subtask gate).

## Open risk to flag before/while building

**X API cost — downgraded risk, verified 2026-07-06.** X API is now pay-per-use
with no monthly minimum ($0.005/post read, no free tier, no subscription
required) rather than the flat ~$200/mo "Basic" tier this plan originally
assumed. At demo scale (a handful of watched authors, `since_id`-based
polling), expected spend is a few dollars total, not a recurring monthly fee —
a real credential/account setup step is still candidate-supplied per the
assignment, but the cost barrier is much lower than first flagged. Remaining
unknown: whether an empty poll (no new posts) still bills per-request or only
per-resource-returned — confirm exact billing granularity in the Developer
Console before running the poller continuously over multiple days, since that
determines whether a short `pollIntervalMinutes` is free-ish or adds up.

## Critical files referenced

- `investors-mcp/app/api/automation/monitor-x/route.ts` — reference behavior (`handleMonitor`, `loadWatchlist`, `getTopSoofiArticleSimilarities`, `buildSoofiArticleRecommendationsForAsana`, `createAsanaTask`, `createAsanaRecommendationSubtasks`) — port behavior, not the Next.js/Postgres stack.
- `investors-mcp/lib/automation/monitor-settings.ts` — settings bounds/defaults to adapt into the new Zod schema.
- `investors-mcp/app/mcp/route.ts` — `queryInvestorContent` tool schema (lines ~583-640).
- `x-engagement-reply-agent/CLAUDE.md` — hard constraints and the exact skill-composition guidance already written for this repo.
- `soofi-xyz-team-kit/skills/build-ai-agents/rules/implementation-bedrock-prompt-caching.md` — port near-verbatim.
- `soofi-xyz-team-kit/skills/apply-engineering-guidelines/rules/observability-dlq-alarms.md` — the DLQ/alarm pattern to adapt into the single-Lambda + Scheduler DLQ.
- `soofi-xyz-team-kit/skills/integrate-ci-cd/SKILL.md` — justfile recipe contract + shared-workflow shape to document (not wire) given no company org access.
- `soofi-xyz-team-kit/agents/meowth.md` — closest kit counter-example for the Step-Functions-vs-Lambda call; confirms this agent's shape (no wait-for-approval resume step) doesn't need it.
- `x-engagement-reply-agent/examples/reference/` — target config/prompt/fixture shapes.

## Agents/skills explicitly considered and ruled out

For completeness — these were checked against the task and don't fit, so they're
intentionally absent from the plan: `ash`, `pelipper`, `lucario` (all inbound
Asana-chat-triggered via `@soofi-xyz/chat-adapter-asana` — this agent only
writes to Asana, never listens); `alakazam`, `espeon` (RAG-system builders —
rebuilding retrieval is out of scope, the hosted MCP already provides it);
`chatot` and the `manage-communication-activity`/`select-communication-audience`/
`manage-channel-templates` skills (SMS/email communication-platform lifecycle,
unrelated data domain); the `build-tenant-*`/`build-product-*`/`build-persist-service`/
`build-marketplace-puller`/etc. SOCAPITAL-platform skills (this is a standalone
agent, not a component of that multi-tenant marketplace platform); `donphan`/
`use-elephant-mcp`/`oracle`/`use-oracle` (a different MCP entirely — Elephant's
open property-data MCP, not investors-mcp).
