# Config & Prompt Schema

All operational configuration is version-controlled files, loaded and
validated at process start by `src/config/watchlist.ts` and
`src/config/settings.ts` (Zod schemas). There is no admin UI and no
database-backed config, and no hot-reload — a config or prompt change
requires editing the file and redeploying (`cdk deploy` / `just deploy`),
matching the assignment's own wording.

**Loading philosophy:** a bad or out-of-bounds value throws immediately with
the specific field and constraint violated. The legacy DB-backed settings
(`investors-mcp/lib/automation/monitor-settings.ts`) silently clamped bad
values on write, because operators edited them through an admin dashboard.
That's the wrong failure mode once config is code-reviewed: a bad value
should fail CI/deploy loudly, not quietly coerce into something the reviewer
never saw.

## `config/watchlist.yaml`

```yaml
authors:
  - author: "Example Author" # display name, required, non-empty
    handle: "exampleauthor" # X handle without "@", required, non-empty
    company: "example-co" # required, non-empty
    aliases:
      handles: [] # additional handles that resolve to this same author
      authors: [] # additional display-name spellings for this same author
    active: true # required boolean; inactive authors are loaded but skipped
```

- At least one author is required.
- Handles are normalized (`@` stripped, lowercased) for duplicate detection —
  two entries with the same handle in different casing/with-or-without `@`
  is a load-time error, not a silent merge.
- `aliases` defaults to `{ handles: [], authors: [] }` if omitted.

## `config/settings.yaml`

| Field | Type | Bounds | Default | Notes |
|---|---|---|---|---|
| `pollIntervalMinutes` | int | 1–1440 | — required | |
| `defaultBatchSize` | int | 1–20 | — required | authors processed per scheduled run before cursor rotation wraps |
| `defaultMaxPostsPerAuthor` | int | 1–100 | — required | |
| `defaultTopK` | int | 1–100 | — required | **widened from the legacy schema's 1–20 cap** as a business-level "how many candidates to consider" knob — but see the live-server cap note below before assuming a value above 20 actually reaches the corpus |
| `asanaTaskSimilarityThreshold` | number | 0–1 | — required | gates **parent task creation** (best raw score across candidate articles; `0` = always create if other checks pass) |
| `articleSimilarityThreshold` | number | 0–1 | — required | gates **which articles get a recommendation subtask** (per-article raw score) — do not confuse with the field above |
| `modelId` | string | non-empty | — required | must be an **Amazon Bedrock** model ID or inference profile enabled in the target account/region (see Legacy vs new fields) |
| `dedupeTtlDays` | int | 1–365 | `90` | *(new)* how long processed-post dedupe entries live in DynamoDB |
| `backfillHours` | int | 1–168 | `24` | *(new)* backfill window used only the first time a handle is polled (no cursor yet) |
| `costCeilingUsdPerRun` | number | > 0 | `5` | *(new)* cost-prediction gate aborts the run above this estimated Bedrock spend |
| `excludedTaskAuthors` | string[] | — | `[]` | *(new)* authors whose own posts never get an Asana task even if otherwise qualifying |
| `maxReplyCharacters` | int | 1–2000 | `280` | *(new, Phase 4)* machine-readable mirror of `prompts/constraints.md`'s "Maximum of 280 characters" line — that file is prose for the LLM, this field is what post-generation validation actually enforces |

### Legacy vs new fields

- **`modelId` must change meaning.** The example file historically shipped
  `modelId: openai/gpt-4.1-mini` — that's a legacy AI-gateway ID from the
  Vercel-hosted reference app. This agent calls Bedrock through the Vercel AI
  SDK, so `modelId` must be a real Bedrock model ID or inference profile
  (e.g. `anthropic.claude-3-5-haiku-20241022-v1:0`), not an AI-gateway string.
- **`defaultTopK`** bound widened 20 → 100 as a config-level knob, but see
  "`defaultTopK` vs. what the live MCP server actually accepts" below — the
  live server itself still caps at 20, and the matching module clamps to it.
- **`dedupeTtlDays`, `backfillHours`, `costCeilingUsdPerRun`,
  `excludedTaskAuthors`** did not exist in the legacy DB-backed schema at all
  — they replace behavior that used to be a mix of hardcoded constants and
  environment variables (`AUTOMATION_AUTO_BACKFILL_WINDOW_HOURS`, a hardcoded
  "skip Soofi's own posts" check, etc.) in the legacy route handler.

### `defaultTopK` vs. what the live MCP server actually accepts (verified discrepancy)

The assignment README's "Required RAG integration" section instructs candidates
to call `queryInvestorContent` with `topK: 40`. **Verified live against
`https://investors-mcp.vercel.app/mcp` on 2026-07-06: the deployed server's own
input schema caps `topK` at 20 and rejects anything higher** — a `topK: 40`
call returns `isError: true` with a non-JSON body
(`MCP error -32602: Input validation error: Invalid arguments for tool
queryInvestorContent`), not the documented JSON match response. This is a real
discrepancy between the assignment's written example and the deployed system,
not a misunderstanding on the client side — confirmed by testing `topK: 20`
(succeeds) immediately followed by `topK: 40` (fails) against the same live
endpoint.

Consequently: `config/settings.yaml`'s `defaultTopK` bound stays widened to
1–100 as a business-level knob (an operator's stated preference for how many
candidates to consider), but `src/matching/get-top-article-similarities.ts`
clamps the value actually sent to the MCP tool at 20
(`MCP_SERVER_TOP_K_MAX`) regardless of what's configured. If the live server's
cap is ever raised, that's a one-constant change, not a schema change.

### Two thresholds — do not conflate

- `asanaTaskSimilarityThreshold` — **parent task gate.** Best raw similarity
  score across all candidate articles for a post. `0` means "always create
  the parent task if other checks pass" (dedupe, excluded-author, etc.).
- `articleSimilarityThreshold` — **per-article subtask gate.** Only articles
  whose raw score clears this threshold get a recommendation subtask (one
  per matched article × prompt slot).

## Prompts

```
prompts/
├── system.md          # system prompt, read verbatim
├── constraints.md      # global response constraints, read verbatim
└── replies/
    ├── 01-recommend-and-draft.md
    ├── 02-agree-and-clarify.md
    ├── 03-agree-with-practical-example.md
    ├── 04-respectfully-disagree.md
    ├── 05-devils-advocate.md
    └── 06-context-note.md
```

- `system.md` and `constraints.md` must exist and be non-empty; their content
  is read verbatim (no templating).
- Every file in `prompts/replies/` must match `NN-slug.md` (e.g.
  `01-recommend-and-draft.md`). `NN` is a numeric prefix used only for sort
  order — the resulting `promptIndex` is the 1-based position after sorting,
  not the literal prefix number, so a renumbered or gapped sequence (e.g.
  `01`, `02`, `04` after deleting `03`) still produces clean sequential
  indices.
- Two files sharing the same numeric prefix is a load-time error.
- There is no hard cap on the number of reply-prompt files — the assignment
  requires supporting **at least six** through prompt files with no code
  change; adding a seventh is adding a file.
- **`promptLabel`** is taken from a leading `# Heading` line in the file
  (e.g. `# Prompt 3 — Agree with a practical example` → label
  `Prompt 3 — Agree with a practical example`). If no heading is present, the
  label falls back to a title-cased version of the filename slug (e.g.
  `agree-and-clarify` → `Agree And Clarify`).
- **`endsWithQuestion` override:** every draft ends in a thought-provoking
  question by default, per the assignment's acceptance criteria. A prompt
  file can opt out by including a literal line `endsWithQuestion: false`
  anywhere in the file; that line is stripped from the content before it's
  used as prompt instructions. See `prompts/replies/06-context-note.md` for
  a working example of this override — it deliberately ends on a stated fact
  rather than a question.

## What's still open

Lambda deployment must bundle `config/` and `prompts/` as static assets
alongside the compiled handler — `NodejsFunction` only bundles imported JS
by default, not arbitrary YAML/Markdown files. This is a Phase 6 deployment
concern (see `docs/implementation-plan.md`), not a schema concern; the
loaders here accept an explicit base directory precisely so the same code
works against a local checkout, a test fixture, and a Lambda-bundled asset
path without modification.
