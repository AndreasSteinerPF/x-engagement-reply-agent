# X Engagement Reply Agent — Guardrails

This repo holds a **job-application take-home assignment** (see `README.md`). The
deliverable is a standalone agent — code lives here, not in `investors-mcp`.

## What this agent does

Poll a configured list of X (Twitter) authors on a schedule → detect new
posts/replies/quotes → match post text against Soofi Safavi's article corpus via
a hosted MCP tool → draft several candidate replies with an LLM (one per prompt
file) → create an Asana parent task + one approval subtask per (article × prompt)
for a human to review and post manually.

**This pipeline is human-in-the-loop by design, not a gap to fill in.** Detection,
matching, drafting, and task creation are fully automated; posting to X is not.
The agent's terminal action is always an Asana approval subtask with an X
compose-intent link — never a call to X's post/reply API. "Automated posting or
replying directly to X without human approval" is explicitly out of scope for
this milestone. Do not add an auto-post path.

## Source of truth, in priority order

1. `README.md` — user story, acceptance criteria, demo script. This is the contract being graded against.
2. `docs/reference-architecture.md` — pipeline map of the legacy implementation (function/file names to read, not to copy).
3. `examples/reference/` — target shapes for `config/watchlist.yaml`, `config/settings.yaml`, prompt Markdown files, and one fixture. Config/prompt schemas MUST be compatible with these shapes.
4. [`prismteam-ai/investors-mcp`](https://github.com/prismteam-ai/investors-mcp) (sibling checkout at `../investors-mcp`) — sanitized reference implementation. Read `app/api/automation/monitor-x/route.ts` (`handleMonitor`, `loadWatchlist`, `getTopSoofiArticleSimilarities`, `buildSoofiArticleRecommendationsForAsana`, `createAsanaTask`, `createAsanaRecommendationSubtasks`) and `lib/automation/monitor-settings.ts`. **Port the behavior, not the stack** — see below.
5. [`soofi-xyz-team-kit`](../soofi-xyz-team-kit) — the target company's agent-building conventions (agents + skills). This new agent should feel like it belongs in that ecosystem.

## Hard constraints (do not violate)

- **No autonomous posting to X.** The agent drafts and tasks; a human clicks the compose link and posts. Do not implement or scaffold a "post directly" mode even behind a flag.
- **No direct vector-store/blob/Postgres credentials.** Article matching MUST go through the hosted MCP tool `queryInvestorContent` at `https://investors-mcp.vercel.app/mcp` (Streamable HTTP). `listInvestorContent` is optional. Never call `addInvestorParagraph` — write access is not provided, and dry-run/local testing must never call write tools.
- **No admin UI, no database-backed config.** Watchlist, settings, and prompts are version-controlled files (`config/watchlist.yaml`, `config/settings.yaml`, `prompts/system.md`, `prompts/constraints.md`, `prompts/replies/*.md`). Adding a 6th reply prompt = adding a file, not a migration.
- **Dedupe is mandatory**: by source URI + status ID for posts, and by existing-task lookup for Asana tasks, so repeated runs don't double-task.
- **Dry-run must be a true no-op** on external writes (no Asana tasks, no MCP write calls) while still returning the same matching/draft output shape as a live run.
- **Preserve provenance**: source URI, article title, and similarity score must survive into both the reply draft and the Asana task/subtask notes.
- **LLM runs must be traceable** (acceptance criteria requires "observable LLM runs" — see Agents & skills below for the concrete telemetry pattern).

## Porting investors-mcp: what to take vs. leave

`investors-mcp` is Next.js + Vercel + Postgres + Upstash Vector + Vercel Blob. That
stack is the *legacy monolith* this milestone extracts the agent out of — do not
re-adopt it. Take the **business logic and data shapes** (watchlist/settings
fields, similarity gating math, Asana task/subtask payload shape, reply output
structure); leave the **hosting/storage stack** behind in favor of the target
company's own conventions (see below).

Two similarity thresholds matter and are easy to conflate — keep them distinct:
- `asanaTaskSimilarityThreshold` gates **parent task creation** (best raw score across candidates; `0` = always create if other checks pass).
- `articleSimilarityThreshold` gates **which articles get a recommendation subtask** (per-article raw score).

`draftSoofiToneResponses` in the reference route is dead code — do not port it.

## Agents & skills to use from `soofi-xyz-team-kit`

No single existing agent is a perfect fit — this is a **scheduled batch job with
an LLM drafting step and outbound Asana writes**, not an inbound Asana-mention
chat bot. Combine two skills rather than forcing one agent's full playbook:

- **`build-batch-workflows`** (and the `machamp` agent as a sparring partner) for the shape of the whole run: schedule trigger → batch/cursor rotation across the watchlist → per-item processing → idempotency → cost/throttle limits → structured run summary. This is the right mental model for the poll loop itself.
- **`build-ai-agents`**, but **only Phases 5, 6, and 8** (AI logic, telemetry, tools/deploy/test) — Amazon Bedrock via the **Vercel AI SDK** for reply drafting, LangSmith tracing per run (this is what satisfies "observable, traceable LLM runs"), typed tool definitions. **Skip Phases 3, 4, and 7** (Chat SDK ingress via `@soofi-xyz/chat-adapter-asana`, DynamoDB Chat SDK state, AgentCore Memory) — those exist for agents that receive and reply to inbound Asana messages. This agent only *writes* Asana tasks via the plain Asana REST API; it does not listen for mentions or hold a conversation, so there is no chat state or conversation memory to manage.
- **`apply-engineering-guidelines`** for the non-negotiables: TypeScript everywhere, **Vercel AI SDK only** for LLM calls (no direct `@aws-sdk/client-bedrock-runtime` or provider SDKs), AWS + CDK as the only deploy path, Powertools-style structured logging, PagerDuty on critical failure, per-DLQ CloudWatch alarms. If this is a take-home without company AWS/PagerDuty/Lexicon access, implement the structural hooks (a `notifyCriticalFailure` seam, structured JSON logs, a metrics interface) and document in the README what would wire into the real services in production, rather than skipping observability entirely.
- **`integrate-ci-cd`** for the `justfile` shape (`format`, `lint`, `type-check`, `test`, `build`, `deploy` — the exact six recipes every kit agent uses). The paired GitHub Actions caller workflows normally call a shared reusable workflow at `Spring-Oaks-Capital-LLC/github-workflows`; that repo is company-private and this assignment repo lives under `prismteam-ai`, so those caller workflows can't be wired for real. Keep the `justfile` (costs nothing, is the right shape), ship a self-contained CI workflow running the same six recipes, and document the gap in the deploy docs rather than silently deviating.
- **`arceus`** if genuinely unsure which agent/skill applies mid-build — it's the router, ask it before guessing.
- Do **not** reach for `alakazam`/`espeon`/RAG-builder skills — rebuilding the RAG/vector layer is explicitly out of scope; the hosted MCP already provides it.
- Do **not** reach for `ash`/`pelipper`/`lucario` either, even though they're the kit's other Asana-integrated agents — all three are *inbound* (Chat SDK, listening for Asana mentions/comments); this agent is *outbound-only* (it writes tasks, never listens). Checked `meowth`'s Step Functions + `WaitForTaskToken` pattern specifically as the closest counter-example before deciding a single Lambda is still right here: `meowth` needs Step Functions because it must pause for days waiting on human approval and then resume into a follow-up step; this agent has no resume-after-approval step — task creation is the terminal action — so that need doesn't apply. See `docs/implementation-plan.md` for the full reasoning.

## Repo conventions

- Config: `config/watchlist.yaml`, `config/settings.yaml` (see `examples/reference/config/*.example.yaml` for schema).
- Prompts: `prompts/system.md`, `prompts/constraints.md`, `prompts/replies/NN-slug.md` — one file per reply slot, numerically prefixed for ordering, at least six by demo time.
- Keep `examples/reference/` read-only reference material — don't edit it; copy shapes into the real `config/`/`prompts/` trees you build.
- Document deployment steps and required credentials in this repo's own README/docs as they're introduced — the assignment's Definition of Done requires this.
