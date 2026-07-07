# X Engagement Reply Agent — `kestrel`

A standalone, code-managed agent that polls watched X authors, matches their posts against Soofi Safavi article content via the hosted **investors-mcp** MCP, drafts prompt-driven recommended replies, and prepares **Asana approval tasks** for a human to review and post. It never posts to X autonomously — every reply is a pending approval gate.

> **Submission — Andreas Steiner ([@AndreasSteinerPF](https://github.com/AndreasSteinerPF))**
>
> | | |
> |---|---|
> | **Live runtime** | **https://x-engagement-reply-agent-clean.vercel.app** — open it, pick an author, press ▶ Run agent (no login) |
> | **Demo video** | _added before final submission_ |
> | **Assignment / user story** | [ASSIGNMENT.md](./ASSIGNMENT.md) (the provided brief, preserved verbatim) |
> | **Repository** | [AndreasSteinerPF/x-engagement-reply-agent](https://github.com/AndreasSteinerPF/x-engagement-reply-agent) |
>
> The live runtime is **credential-free**: open it, pick a watched author, and press **▶ Run agent**. It polls the author, matches each post against the Soofi corpus via the **real** hosted MCP, drafts one reply per code-managed prompt file, and shows the would-be Asana approval tasks (with one-click X compose links) — no login, no setup.

## Why it's different from the reference

The investors-mcp reference pipeline manages watched authors, thresholds, model selection, and prompts through an admin dashboard and a database. This agent moves **all** of that into version-controlled files — the entire operational surface is code. Adding a fifth or sixth reply variant is a new Markdown file, reviewed in a PR, with no migration and no UI.

## Hosted runtime (browser)

The deployed app (`app/`, Next.js) is a thin presentation layer over the exact same pipeline the CLI runs:

- **▶ Run agent** with a **dry-run** toggle and a watched-author selector.
- Renders, for each detected post: the **Soofi article matches with real similarity scores**, one **drafted reply per prompt file** (grounded, ≤280 chars, with the X compose link and char count), the **would-be Asana parent + approval subtasks**, the **run-summary metrics**, and the **LLM traces**.
- Server-renders the **code-managed configuration** (watchlist, thresholds, prompt slots) so it's clear nothing comes from an admin UI or database.

`POST /api/run` is the same endpoint the Agent Network Platform calls for its **"Run agent"** action (the A→B integration): it returns `{ summary, artifact, asana, traces }`, and the platform ingests the run summary into its registry + network metrics.

Run the web runtime locally:

```bash
npm install
npm run web:build && npm run web:start   # http://localhost:3200
# or: npm run web:dev
```

## Run it from the CLI (no credentials required)

```bash
npm install
npm start -- run --dry-run      # match + draft against the REAL MCP, no side effects
npm start -- run                # full local pass; writes would-be Asana tasks to .out/asana/
npm start -- config             # print the resolved config (proves it comes from files)
npm start -- loop               # run continuously on the configured schedule
```

Common flags: `--dry-run`, `--author <handle>`, `--force`, `--batch-size <n>`, `--max-posts <n>`, `--top-k <n>`, `--report-to <platform-url>`, `--interval <min>` (loop).

Tests: `npm test` (44 tests; `RUN_LIVE_MCP=1 npm test` adds a live MCP smoke test).

## How it works

```
load config (settings, watchlist, prompts)
  → select author batch (cursor rotation)
  → poll each author → detect new posts vs last-seen cursor → fetch referenced originals
  → per post:  match against Soofi articles (hosted MCP, REAL)
               gate on thresholds · exclude the corpus author's own posts
               draft one reply per prompt file (grounded, ≤280, ends with a question)
               create Asana parent task + one approval subtask per (article × prompt)
               persist cursor + dedupe key · emit run summary + LLM traces
```

## Configuration (all version-controlled)

| File | Replaces (reference) | Purpose |
|---|---|---|
| `config/settings.yaml` | `automation_settings` row | poll interval, batch size, topK, similarity thresholds, model id, excluded authors |
| `config/watchlist.yaml` | `managed_authors` table | watched authors (name, handle, company, aliases, active) |
| `prompts/system.md` | DB system prompt | the constant system prompt |
| `prompts/constraints.md` | DB constraints | global response constraints (applied to every reply) |
| `prompts/replies/*.md` | DB prompt slots (max 4) | **one reply prompt per file — unlimited slots** |

### Reply prompt files

Each `prompts/replies/*.md` file is one reply slot, ordered by filename. Optional frontmatter:

```markdown
---
label: "Agree & Extend"      # display label (defaults to a name derived from the filename)
requireQuestion: true        # set false to end with a call-to-action instead of a question
---
Agree with the post, then extend it with a specific insight from the matched Soofi article…
```

- **Add a slot:** drop in a new `06-*.md` file. The repo ships `06-call-to-action.md.disabled`; rename it to `.md` to enable the 6th slot (it also demonstrates `requireQuestion: false`).
- **Remove / reorder:** delete or rename files. No code change, no migration.

## Credentials (all optional)

With no `.env`, the agent runs fully: real MCP matching, fixture polling, deterministic grounded drafts, and an offline Asana sink. Provide any of the following to activate the corresponding live adapter — see [`.env.example`](.env.example):

| Variable(s) | Activates |
|---|---|
| `X_BEARER_TOKEN` | live X API v2 polling |
| `ASANA_ACCESS_TOKEN` + `ASANA_PROJECT_GID` (+ optional section/assignee/custom-field GIDs) | live Asana task creation |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (with a matching `modelId` in settings) | live LLM reply drafting |
| `MCP_URL` | override the MCP endpoint (defaults to the hosted one) |
| `PLATFORM_URL` / `--report-to` | post run summaries to the Agent Network Platform |

## Acceptance criteria → evidence

Every acceptance criterion in [ASSIGNMENT.md](./ASSIGNMENT.md) is satisfied; the load-bearing evidence:

| Brief area | Where |
|---|---|
| Standalone, deployable, scheduled agent | `src/cli.ts` (`run`/`loop`), `app/` (hosted runtime) |
| Code-managed config & prompts (≥6 slots, no UI/DB) | `config/`, `prompts/`, `src/config/load.ts` |
| Polling, new-post detection, referenced originals, dedupe | `src/pipeline/run.ts`, `src/adapters/x/` |
| Real MCP article matching (`queryInvestorContent`) | `src/mcp/client.ts`, `src/similarity.ts` |
| Threshold gating (parent task vs recommendation) | `src/pipeline/thresholds.ts` |
| Prompt-driven drafts (grounded, ≤280, ends with question) | `src/adapters/llm/`, `prompts/` |
| Asana parent + approval subtasks w/ X compose links | `src/adapters/asana/`, rendered in `app/` |
| Dry-run with no side effects | `--dry-run`, dry-run toggle in the web UI |
| Structured run summaries + LLM traceability | `src/pipeline/run.ts`, `src/obs/trace.ts` |

## Provenance

This is a standalone build developed by Andreas Steiner. The `@agent-network/contract` package is vendored under `vendor/agent-contract`, and `agent.manifest.yaml` + `agents/kestrel.md` make it registration-ready for the Agent Network Platform.
