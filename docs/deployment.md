# Deployment

**Status: Phase 5 and Phase 6 both complete — the full pipeline is deployed
to AWS and verified live, both locally (`invoke-local.ts`) and as the actual
deployed Lambda, including a real Asana task created by the deployed Lambda
itself.** `XEngagementReplyAgentStack` is live in account `293406302954`
(`us-east-2`): DynamoDB state table, the monitor Lambda, Secrets Manager
references, Bedrock IAM, and an EventBridge Schedule (deliberately left
`DISABLED` — see below) with a DLQ + alarm. Verified via `npm run
demo:trigger` invoking the real deployed Lambda directly, end to end: a
dry run correctly polled a 5-author batch, made real X API calls (15 real
posts fetched from one account), and suppressed all Asana writes; a
subsequent live run against a fresh real post created a real Asana parent
task with 21 real approval subtasks — `outcome: "tasked"`, straight from the
deployed Lambda, not `invoke-local.ts`.

Two real bugs surfaced only by this — the first time the actual Lambda code
path (not `invoke-local.ts`, which never touches `handler.ts`/`run-lock.ts`
at all) ever ran against real DynamoDB/Asana:

- **`run-lock.ts`'s `releaseLock`** used `"owner"` literally in a
  `ConditionExpression` — a DynamoDB reserved keyword, throwing a real
  `ValidationException` on every release. Invisible to the mocked unit test,
  which doesn't validate expression syntax against the reserved-word list.
- **`create-asana-tasking.ts`** required `env.ASANA_ACCESS_TOKEN` (the plain
  env var) to be set, a stale leftover from before the Secrets Manager
  refactor — the deployed Lambda deliberately never sets that plaintext var
  anymore (only `ASANA_ACCESS_TOKEN_SECRET_ARN`), so every real deployed run
  reported `"missing-asana-config"` and skipped tasking, even with a fully
  valid, working Asana client.

Both are fixed, tested, and redeployed — see the commit history around
2026-07-07 for the exact fixes. This document is filled in progressively as
each phase in [`implementation-plan.md`](./implementation-plan.md) lands.
`scripts/invoke-local.ts` calls the real `runMonitor()` orchestrator (the
same function `handler.ts` uses in Lambda), and every dependency has now
been exercised live:

- **X API v2** — real credentials configured (pay-per-use tier, `X_BEARER_TOKEN`).
  `--live-x` verified against three real accounts (`cryptocom`, `propy`, and
  the candidate's own account), including a real referenced-post resolution
  and correct backfill-window bounding on first poll.
- **Hosted MCP** — verified live since Phase 3; also used directly to
  hand-tune a real post's wording against the live corpus before posting it,
  confirming real (not fixture) similarity scoring end-to-end.
- **Amazon Bedrock** — real AWS credentials + model access configured.
  `--live-llm` verified both in isolation (direct model call) and through
  the full drafting pipeline (schema validation, quoted-phrase grounding
  check, and the per-prompt `endsWithQuestion: false` override all fired
  correctly on real model output).
- **Asana** — real PAT + sandbox project configured. `--live-asana` verified
  to create a real parent task + real approval subtasks (including a
  multi-article run producing 18 subtasks across 3 matched articles), and a
  repeat run against the same real post correctly reported
  `already-tasked-existing-task` with zero duplicates created — proving the
  live existing-task-scan dedupe path, not just the DynamoDB fast path.
- **LangSmith** — real API key + project configured. `--live-llm` verified
  to produce real traces: 18 real spans (one per drafted reply), each
  correctly grouped under the run's session, tagged with prompt
  index/label/article metadata, with real latency, token counts, and
  output — satisfying the "observable, traceable LLM runs" acceptance
  criterion with actual evidence, not just a passing unit test.

This is a real, live, end-to-end proof of the core acceptance criteria — not
just passing unit tests against fixtures.

Two more Required Demo Scenarios have since been walked through live:
editing `prompts/replies/03-agree-with-practical-example.md`'s tone (verified
via direct before/after draft comparison against the real corpus and real
Bedrock — the reply's phrasing genuinely shifted from analytical to casual
while still passing grounding validation), and adding a 7th prompt slot
(`07-clarifying-question.md`, zero code changes) — verified via a real Asana
task on a fresh post showing 21 subtasks (3 matched articles × 7 prompts),
directly comparable to an earlier real task's 18 (3 × 6) created before that
prompt existed.

## Purpose

Scheduled agent that polls a configured watchlist of X authors, matches new
posts against Soofi Safavi's article corpus via the hosted `investors-mcp`
MCP, drafts recommended replies with an LLM, and creates Asana approval tasks
for a human to review and post manually. See the repo `README.md` for the
full user story and acceptance criteria.

## Triggers

- **Scheduled:** EventBridge Scheduler (`AWS::Scheduler::Schedule`, see
  `lib/x-engagement-reply-agent-stack.ts`), rate expression derived from
  `config/settings.yaml`'s `pollIntervalMinutes` (currently `1440` — once
  every 24 hours, deliberately rare/cheap for a real deployed schedule, not
  the `2`-minute value used for nothing-runs-automatically local testing).
  **The schedule itself defaults to `DISABLED`** at deploy time — a fresh
  deploy never silently starts polling real X/Bedrock/Asana on a live
  schedule. Set `SCHEDULE_ENABLED=true` in the environment before running
  `cdk deploy` (or `cdk deploy` again after changing it) to turn it on. A
  failed *invocation* (Scheduler couldn't call the Lambda after retries —
  permissions, throttling) lands in a dedicated SQS DLQ with one CloudWatch
  alarm on its depth — distinct from a failed *execution* of the handler's
  own logic, which `notifyCriticalFailure()` already covers separately.
- **Manual/local (fixtures):** `scripts/invoke-local.ts` for dry-run/single-author
  verification without deploying. **Fully implemented** — calls the real
  `runMonitor()` orchestrator with X/MCP/Bedrock/Asana each independently
  real when its flag (`--live-x`/`--live-mcp`/`--live-llm`/`--live-asana`)
  is passed, falling back to an in-memory fixture per dependency when the
  flag is omitted or its credentials aren't configured. `--persist` backs
  cursor/dedupe state with a local
  JSON file instead of an in-memory `Map`, so running the script twice in a
  row provably skips the second time — the one demo scenario that otherwise
  needed a real DynamoDB table to verify. `--force-retask` (bypassing dedupe
  for the prompt-editing demo scenario) is deferred to Phase 7.
- **Manual/deployed (real Lambda):** `npm run demo:trigger` starts a
  localhost-only server (`scripts/demo-server.ts`) with a single HTML page
  and a "Run now" button that invokes the **real deployed Lambda** via
  `@aws-sdk/client-lambda`, for demoing the actual deployed system on demand
  rather than waiting up to 24 hours for the schedule. AWS credentials and
  the `lambda:InvokeFunction` call stay server-side; the browser only talks
  to `localhost:4173`.
- **Scheduled (production):** the real Lambda `handler.ts` — constructs every
  real client/store, acquires the run lock, calls `runMonitor()`, persists
  the run summary, releases the lock — is implemented and deployed by the
  CDK stack above.
- **Evaluator on-demand (public, no AWS credentials needed):** a second
  Lambda (`src/http-handler.ts`) fronted by a Function URL
  (`XEngagementReplyAgentStack.HttpTriggerUrl` in the deploy output) shares
  the exact same `runHandlerCore()` pipeline as `handler.ts`. `GET` on that
  URL serves a small self-contained HTML page (no separate hosting, no side
  effects, no key required just to view it) with a "Run now" button and the
  same friendly result rendering as `demo:trigger`. Actually running the
  pipeline (`POST`) requires a single rotatable API key — resolved from
  Secrets Manager server-side, checked against the `x-api-key` header —
  rather than a standing IAM identity: easier to revoke (delete/rotate one
  secret value), no AWS CLI or credential setup needed on the caller's end.
  **The key value itself is deliberately not committed anywhere in this
  repo** (typed into the page's own input field, or sent as a header
  directly) — it was shared with the evaluator out-of-band. Defaults to
  `dryRun=true` (safe); pass `?dryRun=false` (or uncheck the box in the UI)
  for a real run.

## Inputs

- `config/watchlist.yaml`, `config/settings.yaml` — version-controlled
  operational config, Zod-validated at load time by `src/config/`. Schema
  documented in [`config-schema.md`](./config-schema.md). **Implemented
  (Phase 1).** `config/watchlist.yaml` now includes real X handles
  (`cryptocom`, `propy`, plus the candidate's own account) used for live
  verification, alongside the original placeholder entries — still worth a
  final pass before the Phase 7 demo to pick the definitive author list.
- `prompts/system.md`, `prompts/constraints.md`, `prompts/replies/*.md` —
  version-controlled reply-generation instructions, loaded by
  `src/prompts/load-prompts.ts`. **Implemented (Phase 1)** — six reply-prompt
  slots exist today.

## Outputs

- Asana parent tasks + approval subtasks. **Implemented (Phase 5),
  verified live** — `src/asana/create-asana-tasking.ts` confirmed against a
  real sandbox project, including a real multi-article match producing 18
  subtasks across 3 articles.
- Structured run summaries persisted in DynamoDB. **Implemented (Phase 5)**
  — `src/state/run-summary-store.ts`, written via the side-effect gateway
  (skipped in dry-run, like every other write). Per-handle cursor, dedupe,
  and run-lock state **are implemented (Phase 2)** — see `src/state/`.
  Watchlist batch rotation (`src/state/rotation-store.ts`) was added in a
  post-Phase-5 audit — see `docs/implementation-plan.md` for the fix.

## Dependencies

| Dependency | Status |
|---|---|
| Hosted MCP (`https://investors-mcp.vercel.app/mcp`, `queryInvestorContent`) | Provided, read-only, no credentials required — verified live (Phase 3) |
| X API v2 credentials | Candidate-supplied, **pay-per-use tier** (X moved off fixed monthly tiers to per-resource pricing in Feb 2026) — **verified live** on 2026-07-07 against three real accounts |
| Asana PAT + sandbox project | Candidate-supplied — **verified live** on 2026-07-07: real parent task + subtask creation, and real repeat-run dedupe via the live existing-task scan. Run `npm run asana:discover` to list every workspace/project/section/custom-field GID visible to a new token and get a ready-to-paste env block — Asana's UI doesn't show these GIDs directly. |
| Amazon Bedrock model access (via Vercel AI SDK) | Candidate-supplied AWS account — **verified live** on 2026-07-07: direct model call, full drafting pipeline, and a per-prompt behavioral override all confirmed against `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-2` (Claude 3.5 Haiku was retired from the Bedrock catalog since this project started) |
| LangSmith account (LLM trace observability) | Candidate-supplied — **verified live** on 2026-07-07: real traces observed in the LangSmith UI, grouped by run session, with per-prompt metadata |

## Deploy steps

Prerequisites: AWS CLI configured (`aws configure`) with credentials that can
create IAM roles, CloudFormation stacks, Lambda functions, DynamoDB tables,
EventBridge schedules, SQS queues, and Secrets Manager entries — for a
personal/sandbox AWS account used only for this project, attaching
`AdministratorAccess` to that IAM user is the pragmatic choice (hand-picking
a dozen managed policies buys little extra safety on an account with no
other workloads). A real company account would instead assume a
deploy-scoped role via OIDC, per `integrate-ci-cd` — see the CI/CD note below
for why that's not wired here.

1. **One-time per account/region: bootstrap CDK.**
   ```
   npx cdk bootstrap aws://<account-id>/us-east-2
   ```
   Creates the S3 bucket/ECR repo CDK uses to publish assets (the bundled
   Lambda code, in this stack's case).

2. **Create the four Secrets Manager secrets** the stack references by
   name (CDK never creates these itself — it only reads them at runtime via
   `resolveSecret()`, so the real values never appear in the CloudFormation
   template):
   ```
   aws secretsmanager create-secret --name x-engagement-reply-agent/asana-access-token --secret-string "<your Asana PAT>" --region us-east-2
   aws secretsmanager create-secret --name x-engagement-reply-agent/x-bearer-token --secret-string "<your X bearer token>" --region us-east-2
   aws secretsmanager create-secret --name x-engagement-reply-agent/langsmith-api-key --secret-string "<your LangSmith API key>" --region us-east-2
   aws secretsmanager create-secret --name x-engagement-reply-agent/evaluator-api-key --secret-string "$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")" --region us-east-2
   ```
   The first three are candidate-private credentials. `evaluator-api-key` is
   different in kind — it's the value meant to be handed to an evaluator (see
   "Triggers" above) to gate the public Function URL. Generate it randomly
   as shown, then share the value out-of-band (not via this repo/PR) with
   whoever needs to trigger the deployed system without AWS credentials.
   LangSmith is optional (the facade degrades gracefully if that secret is
   ever unreachable) — still worth creating so tracing works once deployed.

3. **Confirm `.env` has the non-secret values** (`ASANA_PROJECT_GID`,
   `ASANA_WORKSPACE_GID`, `ASANA_SECTION_GID`, `ASANA_ASSIGNEE_GID`,
   `LANGSMITH_PROJECT`, etc.) — `bin/x-engagement-reply-agent.ts` loads
   `.env` automatically (same file `invoke-local.ts` reads), and the stack
   reads these via `loadRuntimeEnv()` at synth time to set the Lambda's
   plain (non-secret) environment variables.

4. **Synth and review before deploying:**
   ```
   npm run build
   ```
   (`cdk synth --strict`.) Worth inspecting the output once — confirms the
   Bedrock IAM resource ARNs, the three secret-read grants, and the
   schedule's `State` (should read `DISABLED` unless `SCHEDULE_ENABLED=true`
   is set) before anything real is created.

5. **Deploy:**
   ```
   npm run deploy
   ```
   (`cdk deploy --require-approval never`.) Creates/updates the
   `XEngagementReplyAgentStack`: the DynamoDB state table, the monitor
   Lambda, the EventBridge Schedule (disabled by default), its DLQ + alarm,
   and the IAM roles/policies above.

6. **Verify without waiting on the schedule:**
   ```
   npm run demo:trigger
   ```
   Opens a local page at `http://127.0.0.1:4173` with a "Run now" button
   that invokes the real deployed Lambda directly — check the "Dry run" box
   for a side-effect-free check first, then uncheck it to create a real
   Asana task from whatever's currently on the configured watchlist.

7. **Enable the real schedule once satisfied:**
   ```
   SCHEDULE_ENABLED=true npm run deploy
   ```
   Flips the `AWS::Scheduler::Schedule`'s state to `ENABLED`, so it starts
   firing every `pollIntervalMinutes` (`1440` by default) on its own. Redeploy
   without that variable set to disable it again.

**Done as of 2026-07-07** — steps 1–6 above have been carried out for real
against the candidate's own AWS account: `cdk bootstrap` completed, all
three secrets created, `XEngagementReplyAgentStack` deployed (14 resources),
and verified live via `npm run demo:trigger`. The schedule remains
`DISABLED` (step 7 not yet taken) — nothing polls automatically until that's
deliberately enabled.

## CI/CD note (`integrate-ci-cd` gap)

The company's `integrate-ci-cd` skill wires every service the same way: a
`justfile` with six recipes (`format`, `lint`, `type-check`, `test`, `build`,
`deploy`) plus two GitHub Actions caller workflows
(`ci-cd-dev.yml`/`ci-cd-prod.yml`) that invoke a shared reusable workflow at
`Spring-Oaks-Capital-LLC/github-workflows` over AWS OIDC.

This repo keeps the `justfile` (see root `justfile` — same six recipes) but
**cannot** wire the real caller workflows: that shared-workflow repo is
company-private, and this assignment repo lives under `prismteam-ai`, not
`Spring-Oaks-Capital-LLC`, so there's no access and no OIDC role to assume.
`.github/workflows/ci.yml` instead runs the same six recipes directly
(`format` → `lint` → `type-check` → `test` → `build`), with `deploy`
intentionally left out of automatic CI — see the comment at the top of that
workflow file.

## Observability note (PagerDuty / Lexicon / Main Dashboard gap)

Per `apply-engineering-guidelines`, every service pages on-call via PagerDuty
on critical failure and registers metrics in Lexicon/Main Dashboard. This
take-home has no access to those company-internal systems, so what's
actually implemented is:

- **`notifyCriticalFailure()`** (`src/observability/notify-critical-failure.ts`)
  — logs a structured ERROR with a `// TODO production: wire PagerDuty
  Events API v2` comment, called from `handler.ts`'s catch block for any
  error escaping `runMonitor` entirely.
- **A real DLQ + CloudWatch alarm** on the EventBridge Schedule's failed
  invocations (`MonitorScheduleDlq` / `MonitorScheduleDlqAlarm` in
  `lib/x-engagement-reply-agent-stack.ts`) — the company's one-alarm-per-DLQ
  pattern, genuinely deployed, but with **no SNS/PagerDuty action attached**
  to that alarm (nothing to page in this take-home). In production, an SNS
  topic subscribed to a PagerDuty integration would sit between the alarm
  and an on-call page.
- **No Lexicon/Main Dashboard metrics registration** — `src/observability/logger.ts`
  is a minimal structured-JSON-to-stdout logger (CloudWatch Logs captures
  it), not a metrics-emission interface. A real deploy would add Powertools
  Metrics (`AuthorsPolled`, `PostsProcessed`, `AsanaTasksCreated`, etc.) and
  register them in Lexicon/Main Dashboard; this take-home has no access to
  either system to verify that wiring against.
- **Cost-prediction gate** — still genuinely deferred (not a stub, not
  built): needs real design work (placement after matching, before
  drafting, plus a per-token cost table for whichever model is configured)
  rather than a quick bolt-on. See `docs/implementation-plan.md`.
