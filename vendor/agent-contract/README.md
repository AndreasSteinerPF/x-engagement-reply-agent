# `@agent-network/contract`

The shared contract that integrates the two milestones — the boundary between a *registrable agent* and the *registry*.

## What it provides

- **`AgentManifest`** (zod schema + type) — everything the registry captures about an agent: id, name, version, ownership, model, purpose, capabilities, triggers, inputs, outputs, dependencies (services / tools / skills / agents / data sources / packages), runtime, documentation, and provenance. The X agent ships one as `agent.manifest.yaml`.
- **`RunSummary`** — the structured outcome of one agent run (metrics + skip/failure reasons). The X agent emits these; the platform ingests them as network metrics.
- **`AgentRecord` / `CertificationEvent`** — the registry's stored shape (manifest + lifecycle + certification history + runs) and the lifecycle/certification audit events.
- **`LifecycleStatus` / `CertificationTier`** — the lifecycle states and certification tiers, with labels and the `isMarketplaceVisible` gate.
- **Metadata extraction** — `parseTeamKitAgent` (turns a team-kit `agents/*.md` file into an `AgentManifest`) and `parseAgentManifestYaml` (parses a serialized manifest), plus the supporting helpers (`splitFrontmatter`, `extractSections`, `extractWorkflowSteps`, `detectServices`, `detectSkills`). This is what lets the platform ingest *any* agent — the 30 team-kit agents and this repo's X agent alike — through one path.

Schemas are validated with `zod`; the package ships TypeScript source consumed directly by both deliverables.
