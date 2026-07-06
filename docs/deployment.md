# Deployment

**Status: Phase 5 complete (Asana tasking + full orchestration wiring).**
This document is filled in progressively as each phase in
[`implementation-plan.md`](./implementation-plan.md) lands. Nothing in this
repo is deployed yet. `scripts/invoke-local.ts` now calls the real
`runMonitor()` orchestrator (the same function `handler.ts` uses in Lambda)
against an in-memory X fixture, with `--live-mcp`/`--live-llm`/`--live-asana`
each independently opting into the real hosted MCP, real Amazon Bedrock +
LangSmith, and real Asana respectively — falling back gracefully to a
fixture/dry-run when a flag is passed without its matching credentials
configured. This sandbox has X/Bedrock/LangSmith/Asana credentials
configured for none of them, so live verification has only gone as far as
"reaches the real dependency and fails for the right reason" (missing
credentials) for Bedrock and Asana; MCP has been verified against real
production data (Phase 3).

## Purpose

Scheduled agent that polls a configured watchlist of X authors, matches new
posts against Soofi Safavi's article corpus via the hosted `investors-mcp`
MCP, drafts recommended replies with an LLM, and creates Asana approval tasks
for a human to review and post manually. See the repo `README.md` for the
full user story and acceptance criteria.

## Triggers

- **Scheduled:** EventBridge Scheduler, interval from `config/settings.yaml`'s
  `pollIntervalMinutes`. *(Not yet wired — Phase 6.)*
- **Manual/local:** `scripts/invoke-local.ts` for dry-run/single-author
  verification without deploying. **Fully implemented** — calls the real
  `runMonitor()` orchestrator with X always fixture-backed (no candidate X
  credentials exist yet) and MCP/Bedrock/Asana each independently real when
  their flag is passed. `--persist` backs cursor/dedupe state with a local
  JSON file instead of an in-memory `Map`, so running the script twice in a
  row provably skips the second time — the one demo scenario that otherwise
  needed a real DynamoDB table to verify. `--force-retask` (bypassing dedupe
  for the prompt-editing demo scenario) is deferred to Phase 7.
- **Scheduled (production):** the real Lambda `handler.ts` is implemented
  (constructs every real client/store, acquires the run lock, calls
  `runMonitor()`, persists the run summary, releases the lock) but is not
  yet deployed or wired to an actual EventBridge Scheduler trigger — that's
  Phase 6.

## Inputs

- `config/watchlist.yaml`, `config/settings.yaml` — version-controlled
  operational config, Zod-validated at load time by `src/config/`. Schema
  documented in [`config-schema.md`](./config-schema.md). **Implemented
  (Phase 1).** `config/watchlist.yaml` still holds a placeholder author —
  swap in 3+ real X handles before the Phase 7 demo.
- `prompts/system.md`, `prompts/constraints.md`, `prompts/replies/*.md` —
  version-controlled reply-generation instructions, loaded by
  `src/prompts/load-prompts.ts`. **Implemented (Phase 1)** — six reply-prompt
  slots exist today.

## Outputs

- Asana parent tasks + approval subtasks. **Implemented (Phase 5)** —
  `src/asana/create-asana-tasking.ts`; not yet verified against a real
  sandbox project (no Asana credentials configured in this sandbox).
- Structured run summaries persisted in DynamoDB. **Implemented (Phase 5)**
  — `src/state/run-summary-store.ts`, written via the side-effect gateway
  (skipped in dry-run, like every other write). Per-handle cursor,
  batch-rotation, dedupe, and run-lock state **are implemented (Phase 2)** —
  see `src/state/`.

## Dependencies

| Dependency | Status |
|---|---|
| Hosted MCP (`https://investors-mcp.vercel.app/mcp`, `queryInvestorContent`) | Provided, read-only, no credentials required — verified live (Phase 3) |
| X API v2 credentials | Candidate-supplied — not yet configured |
| Asana PAT + sandbox project | Candidate-supplied — not yet configured; code wired (Phase 5), `--live-asana` verified to gracefully fall back to dry-run without credentials. Once you have a PAT, run `npm run asana:discover` to list every workspace/project/section/custom-field GID visible to it and get a ready-to-paste env block — Asana's UI doesn't show these GIDs directly. |
| Amazon Bedrock model access (via Vercel AI SDK) | Candidate-supplied AWS account — code wired and reaches Bedrock (Phase 4), but not yet run against a real model since this sandbox has no AWS credentials |
| LangSmith account (LLM trace observability) | Candidate-supplied — facade implemented and degrades gracefully without a key (Phase 4), but no real trace has been observed yet |

## Deploy steps

Not yet applicable — no AWS account is wired up. Once Phase 6 lands, this
section will list the exact `aws ssm put-parameter` / `aws secretsmanager
create-secret` commands (per the pattern in `soofi-xyz-team-kit/agents/meowth.md`)
and the `just deploy` invocation.

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
take-home has no access to those company-internal systems. Once Phase 6 lands,
this section documents exactly what's implemented as a structural stub
(`notifyCriticalFailure()`, structured logs, a metrics interface) versus what
would wire into the real services in production.
