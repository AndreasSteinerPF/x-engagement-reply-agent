import { z } from "zod";

/**
 * The Soofi Agent Network contract.
 *
 * This module is the single source of truth for the two data shapes that cross
 * the boundary between a *registrable agent* (e.g. the X Engagement Reply Agent)
 * and the *registry* (the Agent Network Platform):
 *
 *   1. {@link AgentManifest}  — everything the registry must capture about an agent
 *      (ownership, version, purpose, capabilities, dependencies, inputs, outputs,
 *      documentation, runtime). An agent ships this so it is "registration ready".
 *
 *   2. {@link RunSummary}     — the structured outcome of one agent run, posted to
 *      the registry to power run history and network usage metrics.
 *
 * The platform layers lifecycle + certification on top (see {@link AgentRecord}),
 * but the manifest itself is portable and tool-agnostic.
 */

/** Lifecycle states an agent moves through in the registry. Verbatim from the platform brief. */
export const LIFECYCLE_STATUSES = [
  "discovered",
  "registered",
  "in_review",
  "changes_requested",
  "certified",
  "rejected",
  "deprecated",
  "suspended",
] as const;
export const LifecycleStatusSchema = z.enum(LIFECYCLE_STATUSES);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** Human-friendly labels for each lifecycle state. */
export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  discovered: "Discovered",
  registered: "Registered",
  in_review: "In Review",
  changes_requested: "Changes Requested",
  certified: "Certified",
  rejected: "Rejected",
  deprecated: "Deprecated",
  suspended: "Suspended",
};

/** Certification tiers assigned when an agent is certified. */
export const CERTIFICATION_TIERS = ["core", "community", "experimental"] as const;
export const CertificationTierSchema = z.enum(CERTIFICATION_TIERS);
export type CertificationTier = z.infer<typeof CertificationTierSchema>;

/** A named input or output of an agent. */
export const IOFieldSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
});
export type IOField = z.infer<typeof IOFieldSchema>;

/** Who owns / maintains an agent. */
export const OwnerSchema = z.object({
  name: z.string(),
  org: z.string().optional(),
  contact: z.string().optional(),
});
export type Owner = z.infer<typeof OwnerSchema>;

/**
 * The agent's dependency surface — what it connects to. Powers the registry's
 * "visibility into agent dependencies, connected tools, data sources, and
 * agent-to-agent interactions" requirement.
 */
export const DependenciesSchema = z.object({
  /** External services the agent talks to (e.g. "X API", "Asana", "investors-mcp"). */
  services: z.array(z.string()).default([]),
  /** Other agents this agent invokes (agent-to-agent). */
  agents: z.array(z.string()).default([]),
  /** Team-kit skills loaded by the agent. */
  skills: z.array(z.string()).default([]),
  /** Connected tools (e.g. MCP tools). */
  tools: z.array(z.string()).default([]),
  /** Data sources read/written (e.g. "Soofi article corpus"). */
  dataSources: z.array(z.string()).default([]),
  /** Runtime packages of note. */
  packages: z.array(z.string()).default([]),
});
export type Dependencies = z.infer<typeof DependenciesSchema>;

/** How the agent is deployed and run. */
export const RuntimeSchema = z.object({
  language: z.string().optional(),
  entrypoint: z.string().optional(),
  deploy: z.string().optional(),
  schedule: z.string().optional(),
  /** Names of environment variables the agent needs at deploy time (not values). */
  requiredEnv: z.array(z.string()).default([]),
});
export type Runtime = z.infer<typeof RuntimeSchema>;

/** Where an agent record originated. */
export const ProvenanceSchema = z.object({
  kind: z.enum(["github", "local", "manual"]),
  /** repo "owner/name", filesystem path, or free-text for manual entries. */
  location: z.string(),
  ref: z.string().optional(),
  path: z.string().optional(),
  discoveredAt: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Prose/markdown documentation surfaced on the agent profile + marketplace. */
export const DocumentationSchema = z.object({
  /** One-paragraph "how it works". */
  overview: z.string().optional(),
  /** Install / setup guidance (markdown). */
  installation: z.string().optional(),
  /** Usage / integration guidance (markdown). */
  usage: z.string().optional(),
});
export type Documentation = z.infer<typeof DocumentationSchema>;

/**
 * The full agent metadata record. This is what an agent declares about itself
 * and what the registry stores. Optional fields degrade gracefully so that a
 * thinly-described discovered agent and a fully-certified one share one shape.
 */
export const AgentManifestSchema = z.object({
  /** Stable kebab-case identifier (e.g. "decidueye"). */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case"),
  /** Display name (e.g. "Decidueye — X Engagement Reply Agent"). */
  name: z.string(),
  /** Semantic version of the agent. */
  version: z.string().default("0.0.0"),
  /** One-sentence description: what + when to use. */
  description: z.string(),
  /** Longer "what it does / how it works". */
  purpose: z.string().default(""),
  /** Model the agent's reasoning uses, if any. */
  model: z.string().optional(),
  /** True for pure routers that recommend but do not act. */
  readonly: z.boolean().optional(),

  owner: OwnerSchema,
  repository: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).default([]),

  /** What the agent can do (bullet capabilities). */
  capabilities: z.array(z.string()).default([]),
  /** When the agent runs / what triggers it. */
  triggers: z.array(z.string()).default([]),
  inputs: z.array(IOFieldSchema).default([]),
  outputs: z.array(IOFieldSchema).default([]),

  dependencies: DependenciesSchema.default({}),
  runtime: RuntimeSchema.optional(),
  documentation: DocumentationSchema.optional(),

  source: ProvenanceSchema,
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/** Counters emitted by one agent run. */
export const RunMetricsSchema = z.object({
  authorsPolled: z.number().int().default(0),
  postsFetched: z.number().int().default(0),
  newPostsProcessed: z.number().int().default(0),
  referencedPostsFetched: z.number().int().default(0),
  articlesMatched: z.number().int().default(0),
  repliesGenerated: z.number().int().default(0),
  asanaParentTasksCreated: z.number().int().default(0),
  asanaSubtasksCreated: z.number().int().default(0),
  ingested: z.number().int().default(0),
  skipped: z.number().int().default(0),
  failed: z.number().int().default(0),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/** The structured outcome of one agent run. Posted to the registry as a network metric. */
export const RunSummarySchema = z.object({
  agentId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  dryRun: z.boolean().default(false),
  status: z.enum(["success", "partial", "failed", "skipped"]),
  metrics: RunMetricsSchema,
  /** Map of skip/failure reason -> count. */
  reasons: z.record(z.string(), z.number().int()).default({}),
  notes: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** A single decision in an agent's certification/lifecycle history. */
export const CertificationEventSchema = z.object({
  at: z.string(),
  actor: z.string(),
  from: LifecycleStatusSchema.optional(),
  to: LifecycleStatusSchema,
  decision: z
    .enum(["promote", "register", "submit", "approve", "request_changes", "reject", "publish", "deprecate", "suspend", "reinstate"])
    .optional(),
  tier: CertificationTierSchema.optional(),
  notes: z.string().optional(),
  /** Automated certification check results, if any. */
  checks: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
});
export type CertificationEvent = z.infer<typeof CertificationEventSchema>;

/**
 * The registry's stored record: the portable manifest plus the platform-owned
 * lifecycle, certification, and run history.
 */
export const AgentRecordSchema = z.object({
  manifest: AgentManifestSchema,
  status: LifecycleStatusSchema,
  certificationTier: CertificationTierSchema.optional(),
  certifiedAt: z.string().optional(),
  history: z.array(CertificationEventSchema).default([]),
  runs: z.array(RunSummarySchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

/** Only certified agents may appear in the marketplace. */
export function isMarketplaceVisible(record: Pick<AgentRecord, "status">): boolean {
  return record.status === "certified";
}
