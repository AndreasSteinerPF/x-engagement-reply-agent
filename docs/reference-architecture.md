# X Engagement Pipeline — Reference Architecture

This document maps the **investors-mcp** automation pipeline for candidates building the X Engagement Reply Agent.

The sanitized reference implementation lives at [prismteam-ai/investors-mcp](https://github.com/prismteam-ai/investors-mcp). Start with `app/api/automation/monitor-x/route.ts` and `lib/automation/monitor-settings.ts`. This doc and [`examples/reference/`](../examples/reference/) are a lighter companion.

## End-to-end flow

```
Schedule trigger
  → load settings + watchlist (Postgres today; code config in target agent)
  → acquire run lock, check poll interval
  → select author batch (cursor rotation)
  → for each author: fetch X posts
  → detect new posts vs last-seen status ID
  → fetch referenced originals (reply/quote threads)
  → for each post:
        optional RAG ingest
        vector similarity vs Soofi articles
        optional parent Asana task
        LLM reply drafts per prompt slot
        Asana approval subtasks
        persist run + post tracking state
```

## Key functions (read these first)

| Step | Function | File |
|------|----------|------|
| Orchestration | `handleMonitor` | `app/api/automation/monitor-x/route.ts` |
| Watchlist | `loadWatchlist` | same |
| Article match | `getTopSoofiArticleSimilarities` | same |
| Reply generation | `buildSoofiArticleRecommendationsForAsana` | same |
| Asana parent task | `createAsanaTask` | same |
| Asana subtasks | `createAsanaRecommendationSubtasks` | same |
| Settings types/defaults | `MonitorAutomationSettings` | `lib/automation/monitor-settings.ts` |

## MCP integration (candidates)

Production article matching for the new agent should call the hosted MCP read tool `queryInvestorContent` rather than direct vector credentials. See [Candidate dependencies](../README.md#candidate-dependencies) in the README.

## Configuration today vs target agent

| Concern | Today | Target agent |
|---------|-------|--------------|
| Watched authors | Postgres `managed_authors` | `config/watchlist.yaml` |
| Settings / thresholds | Postgres `automation_settings` | `config/settings.yaml` |
| Reply prompts | DB / admin (max 4 slots) | `prompts/replies/*.md` |

Examples: [`examples/reference/`](../examples/reference/).

## Legacy / unused paths

`draftSoofiToneResponses` exists in the reference route file but is **not** used by the current production pipeline.
