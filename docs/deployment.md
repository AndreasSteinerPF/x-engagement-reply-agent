# Deployment

**Status: Phase 5 complete (Asana tasking + full orchestration wiring), and
the full pipeline has been verified end-to-end against real external
systems.** This document is filled in progressively as each phase in
[`implementation-plan.md`](./implementation-plan.md) lands. Nothing in this
repo is deployed yet (no Lambda/EventBridge/DynamoDB — that's Phase 6), but
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
  `runMonitor()` orchestrator with X/MCP/Bedrock/Asana each independently
  real when its flag (`--live-x`/`--live-mcp`/`--live-llm`/`--live-asana`)
  is passed, falling back to an in-memory fixture per dependency when the
  flag is omitted or its credentials aren't configured. `--persist` backs
  cursor/dedupe state with a local
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
  (skipped in dry-run, like every other write). Per-handle cursor,
  batch-rotation, dedupe, and run-lock state **are implemented (Phase 2)** —
  see `src/state/`.

## Dependencies

| Dependency | Status |
|---|---|
| Hosted MCP (`https://investors-mcp.vercel.app/mcp`, `queryInvestorContent`) | Provided, read-only, no credentials required — verified live (Phase 3) |
| X API v2 credentials | Candidate-supplied, **pay-per-use tier** (X moved off fixed monthly tiers to per-resource pricing in Feb 2026) — **verified live** on 2026-07-07 against three real accounts |
| Asana PAT + sandbox project | Candidate-supplied — **verified live** on 2026-07-07: real parent task + subtask creation, and real repeat-run dedupe via the live existing-task scan. Run `npm run asana:discover` to list every workspace/project/section/custom-field GID visible to a new token and get a ready-to-paste env block — Asana's UI doesn't show these GIDs directly. |
| Amazon Bedrock model access (via Vercel AI SDK) | Candidate-supplied AWS account — **verified live** on 2026-07-07: direct model call, full drafting pipeline, and a per-prompt behavioral override all confirmed against `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-2` (Claude 3.5 Haiku was retired from the Bedrock catalog since this project started) |
| LangSmith account (LLM trace observability) | Candidate-supplied — **verified live** on 2026-07-07: real traces observed in the LangSmith UI, grouped by run session, with per-prompt metadata |

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
