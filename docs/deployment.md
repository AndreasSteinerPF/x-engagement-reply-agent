# Deployment

**Status: Phase 0 (scaffold).** This document is filled in progressively as
each phase in [`implementation-plan.md`](./implementation-plan.md) lands.
Nothing in this repo is deployed yet.

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
  verification without deploying. *(Not yet implemented — Phase 2+.)*

## Inputs

- `config/watchlist.yaml`, `config/settings.yaml` — version-controlled
  operational config. *(Not yet implemented — Phase 1.)*
- `prompts/system.md`, `prompts/constraints.md`, `prompts/replies/*.md` —
  version-controlled reply-generation instructions. *(Not yet implemented —
  Phase 1.)*

## Outputs

- Asana parent tasks + approval subtasks. *(Not yet implemented — Phase 5.)*
- Structured run summaries persisted in DynamoDB. *(Not yet implemented —
  Phase 2/6.)*

## Dependencies

| Dependency | Status |
|---|---|
| Hosted MCP (`https://investors-mcp.vercel.app/mcp`, `queryInvestorContent`) | Provided, read-only, no credentials required today |
| X API v2 credentials | Candidate-supplied — not yet configured |
| Asana PAT + sandbox project | Candidate-supplied — not yet configured |
| Amazon Bedrock model access (via Vercel AI SDK) | Candidate-supplied AWS account — not yet configured |
| LangSmith account (LLM trace observability) | Candidate-supplied — not yet configured |

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
