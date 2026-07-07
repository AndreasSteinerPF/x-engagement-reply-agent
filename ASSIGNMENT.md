# X Engagement Reply Agent

Targeted Author X Polling, Engagement Detection, and Recommended Reply Workflow

## Context

Elephant's internal **investors-mcp** application currently implements a production workflow that polls targeted X authors for new posts, ingests posts into a knowledge corpus, compares each post against Soofi Safavi article content using semantic similarity, drafts recommended X replies, and creates Asana approval tasks for a human operator to review and post manually.

That workflow is embedded in a monolithic application. Operational behavior — watched authors, similarity thresholds, draft prompts, response constraints, and model selection — is managed through an admin dashboard and persistent storage rather than version-controlled configuration. Prompt evolution (adding a fifth or sixth reply variant, changing tone, or adjusting constraints) requires dashboard edits or database changes instead of pull-request review.

The soofi.xyz agent ecosystem defines reusable agent patterns through the [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit), including code-managed prompts, observability, and integration conventions. This milestone extracts the investors-mcp targeted-author polling and recommended-reply pipeline into a standalone agent that fits that architecture and can be registered in the future Agent Network.

## Description

Create an **X Engagement Reply Agent** that continuously monitors a configured set of X authors, detects new posts and relevant engagement opportunities (including replies and quoted posts to referenced originals), optionally ingests content into the investor knowledge layer, matches posts against Soofi article content, generates multiple recommended reply drafts from version-controlled prompt files, and creates Asana parent tasks and approval subtasks for human review and posting.

The agent must replace dashboard- and database-managed configuration with **code-managed configuration** (structured config files and Markdown prompt files). Operators should evolve reply behavior — tone, count, constraints, and prompt instructions — by editing files in the repository and redeploying, without requiring admin UI changes.

The agent must preserve the current operational outcomes of investors-mcp:

- **X integration (polling):** scheduled polling of watched authors, new-post detection, referenced-post enrichment, and deduplication of already-processed posts
- **Asana integration (tasking):** parent task creation for each qualifying post, article-recommendation approval subtasks per reply prompt, similarity metadata, threshold-based assignee rules, and X compose intent links in task notes

## Acceptance Criteria

### Agent architecture

- Implement the agent as a standalone, deployable unit aligned with conventions in [soofi-xyz-team-kit](https://github.com/soofi-xyz/soofi-xyz-team-kit).
- Run the polling pipeline on a configurable schedule.
- Persist runtime state externally for polling cursors, processed-post dedupe keys, and run summaries.
- Generate recommended replies using a language model with observable, traceable LLM runs.
- Document agent purpose, triggers, inputs, outputs, dependencies, and deployment steps.
- Preserve compatibility with future Agent Network registration and certification workflows.

### Code-managed configuration

- Move watched-author definitions from admin/database storage to version-controlled config, including author name, handle, company, aliases, and active flag.
- Move automation settings (poll interval, batch size, max posts per author, similarity thresholds, model selection) to version-controlled config.
- Move all reply-generation instructions to Markdown prompt files, including:
  - system prompt
  - global response constraints
  - one file per reply slot/prompt (not limited to four slots)
- Support adding, removing, or reordering reply prompts by editing prompt files only — no database migration or admin UI required.
- Remove dependency on the investors-mcp admin UI for normal agent operation.
- Document the config and prompt file schema.

### X integration — polling and engagement detection

- Poll configured X authors on a schedule and detect posts newer than the last-seen cursor per handle.
- Support batching across the watchlist using configurable batch size and cursor rotation.
- Detect and process referenced originals when a watched author replies to or quotes another post.
- Enrich long-form X article content where available.
- Deduplicate already-processed posts by source URI and status ID.
- Record per-post processing outcomes (ingested, skipped, tasked, failed) in persistent state.
- Support dry-run mode that executes the pipeline without knowledge-base writes or Asana task creation.

### Knowledge retrieval and article matching

- Integrate with the hosted investors-mcp MCP (`queryInvestorContent`) for article matching; do not use direct vector-store or blob credentials.
- Compare each new post against Soofi Safavi article content using semantic similarity.
- Apply configurable thresholds for:
  - parent Asana task creation (best-match raw similarity)
  - article recommendation and subtask generation (per-article raw similarity)
- Return top matched articles with similarity scores and supporting excerpts or passages.
- Preserve source provenance (source URI, article title, similarity score) in downstream outputs.

### Recommended reply generation (prompt-driven)

- Generate one recommended X reply per configured prompt file for each threshold-qualified matched article.
- Load prompt instructions, tones, and constraints from Markdown files.
- Support at least six reply prompt slots through prompt files without code changes.
- Enforce configurable response constraints (character limits, voice, formatting rules) from prompt and config files.
- Ground each reply in matched article content; include a quoted phrase from the article context.
- End each reply with a thought-provoking question unless a prompt file explicitly overrides that behavior.
- Produce structured output suitable for Asana subtask creation (prompt label, prompt text, draft reply, why recommended).

### Asana integration — task creation for posting workflow

- Create a parent Asana task for each qualifying post with source post metadata, thresholds applied, and top article matches.
- Create one approval subtask per `(matched article × reply prompt)` with draft reply text and an X compose intent link.
- Support configurable Asana project, section, workspace, default assignee, and threshold-based assignee override.
- Set parent task due date to today when threshold-based assignee rules apply.
- Write similarity score custom fields on parent and subtasks when configured.
- Dedupe Asana task creation for posts already tasked in prior runs.
- Skip task creation for excluded authors (for example the corpus author's own posts).

### Observability, operations, and documentation

- Emit structured run summaries including authors polled, posts fetched, new posts processed, ingest counts, Asana tasks created, and skip/failure reasons.
- Support local or isolated testing against a single author or post without side effects.
- Document deployment steps and required credentials or configuration.

### Out of scope for this milestone

- Automated posting or replying directly to X without human approval.
- Replacing the investors-mcp knowledge platform entirely (the agent may consume it as a dependency).
- Agent Network marketplace publication (prepare for registration only).
- Admin dashboard parity with investors-mcp reporting UI.

## Demo Requirements

- Deliver a live demonstration using a configured watchlist of at least three real X authors.
- Demonstrate scheduled polling detecting a new post from a watched author.
- Demonstrate referenced-post handling when a watched author replies to or quotes another post.
- Demonstrate article similarity matching against Soofi content with visible similarity scores.
- Demonstrate generation of multiple recommended replies from distinct prompt Markdown files (minimum five prompts configured in the demo).
- Demonstrate adding a sixth reply prompt by editing a prompt file, redeploying, and showing the new reply variant on a subsequent run.
- Demonstrate Asana parent task creation with source post metadata and similarity notes.
- Demonstrate Asana approval subtasks containing draft replies and X compose links.
- Demonstrate threshold-based parent-task assignee behavior and due-date assignment.
- Demonstrate dry-run mode producing the same matching and draft outputs without creating Asana tasks.
- Demonstrate traceability of LLM reply-generation runs.
- Demonstrate that watched authors, thresholds, and prompts are loaded from code-managed config files — not from an admin UI or database settings.

## Required Demo Scenarios

- Poll watched authors and process one newly detected post end to end.
- Show a post that meets the article recommendation threshold receiving multiple reply subtasks (one per prompt file).
- Show a post that does not meet the recommendation threshold creating no reply subtasks (or skipping parent task creation when task threshold is configured).
- Edit a prompt Markdown file to change reply tone and show the updated draft on the next run.
- Add a new prompt file (5th or 6th reply slot) and show an additional subtask created for the same matched article.
- Open an Asana approval subtask and use the embedded X compose link to preview the drafted reply.
- Run dry-run mode for a single author and review structured output without side effects.

## Definition of Done

This milestone is complete when the X Engagement Reply Agent loads all operational configuration and prompts from version-controlled files, polls X for targeted authors on a schedule, generates prompt-driven recommended replies from Soofi article matches, creates Asana approval workflows equivalent to investors-mcp, and demonstrates the required scenarios above with observable LLM runs and structured run summaries.

## Candidate dependencies

### Provided by Elephant

| Dependency | Access | Purpose |
|------------|--------|---------|
| [investors-mcp (public fork)](https://github.com/prismteam-ai/investors-mcp) | Public git | Sanitized reference code, schema, pipeline map |
| [Reference architecture](./docs/reference-architecture.md) | This repo | Short pipeline summary and key function names |
| [Example config and prompts](./examples/reference/) | This repo | Target config/prompt shapes and fixtures |
| Production MCP (read-only) | URL + tools below | Semantic search over Soofi Safavi article corpus |
| This user story | This repo | Requirements, acceptance criteria, demo |

Clone the public fork for the full sanitized source tree (`monitor-x` route, migrations, MCP server code). The docs and examples in this repo are a lighter companion; the fork is the primary code reference.

**MCP endpoint:** `https://investors-mcp.vercel.app/mcp`  
**Transport:** Streamable HTTP MCP (JSON-RPC over HTTP; use any MCP client that supports streamable HTTP)

**Allowed read tools:**

- `queryInvestorContent` — **required** for article matching and reply grounding
- `listInvestorContent` — optional, for filtered listing by author, date, or segment type

**Not provided (candidates supply their own):**

- X API credentials and test watchlist handles
- Asana project, personal access token, and sandbox assignees
- LLM provider credentials and observability tooling
- Write access to the knowledge corpus (`addInvestorParagraph` / `MCP_WRITE_TOKEN`)

### Required RAG integration

The agent **must** match posts against Soofi articles by calling the hosted MCP — not by connecting directly to the vector store or blob storage.

For each candidate post, call `queryInvestorContent` with the post text as the query and scope to Soofi articles:

```json
{
  "query": "<full text of the X post>",
  "author": "Soofi Safavi",
  "contentType": "article",
  "segmentType": "article_full",
  "topK": 40
}
```

Use returned match scores for threshold gating (parent task vs recommendation subtasks) and use matched article content when generating reply drafts.

**Do not** ingest monitored X posts into the production investors-mcp corpus unless explicitly authorized. Dry-run and local testing must not call write tools.

### Operator setup (Elephant)

Before candidates start, confirm:

1. Production MCP is live at `https://investors-mcp.vercel.app/mcp`
2. A smoke test of `queryInvestorContent` with the Soofi article filters above succeeds
3. The [public investors-mcp fork](https://github.com/prismteam-ai/investors-mcp) is published and candidates can clone it
4. Candidates receive the MCP URL and example query — not `MCP_WRITE_TOKEN` or infrastructure credentials

Read access to MCP query tools is currently open (no read token required). Optional hardening such as a dedicated read token or rate limits may be added later; candidates will be notified if authentication becomes required.

### Out of scope for candidates

- investors-mcp admin / reporting UI (`/reporting`, `/authors`, `/polling`, `/replies`)
- Postgres-backed watchlist or automation settings in investors-mcp
- Rebuilding or replacing the MCP server or RAG platform

## Reference

- [investors-mcp (public fork)](https://github.com/prismteam-ai/investors-mcp) — sanitized reference implementation
- [Reference architecture](./docs/reference-architecture.md) — pipeline map for the investors-mcp workflow
- [Example config and prompts](./examples/reference/) — target shapes for watchlist, settings, prompts, and fixtures
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
