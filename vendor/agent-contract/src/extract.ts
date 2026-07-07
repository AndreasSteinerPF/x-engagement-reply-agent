import { parse as parseYaml } from "yaml";
import {
  AgentManifestSchema,
  type AgentManifest,
  type Dependencies,
  type IOField,
  type Provenance,
} from "./schema.js";

/**
 * Metadata extraction — the bridge that lets the registry ingest *any* agent.
 *
 * Two input shapes are supported:
 *   - a team-kit agent file: YAML frontmatter (`name`, `description`, `model`,
 *     `readonly`) + an imperative markdown body whose section headers
 *     (Goal, Success Criteria, Inputs, Constraints, Output, ...) map to metadata.
 *   - a structured `agent.manifest.yaml`: a direct serialization of an
 *     {@link AgentManifest} (what registration-ready agents ship).
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** Split leading `---\n...\n---` YAML frontmatter from the markdown body. */
export function splitFrontmatter(markdown: string): Frontmatter {
  const normalized = markdown.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: normalized };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Tolerate malformed frontmatter — body is still useful.
  }
  return { data, body: match[2] ?? "" };
}

/**
 * Map markdown section headers to their content. Keys are lowercased header text
 * (e.g. "goal", "success criteria"). Supports `#`..`######` and bold-line headers
 * like `**Goal**`.
 */
export function extractSections(body: string): Record<string, string> {
  const lines = body.split(/\r?\n/);
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections[current] = buffer.join("\n").trim();
    buffer = [];
  };
  for (const line of lines) {
    const hash = line.match(/^#{1,6}\s+(.+?)\s*$/);
    const bold = line.match(/^\*\*(.+?)\*\*\s*:?\s*$/);
    const header = hash?.[1] ?? bold?.[1];
    if (header) {
      flush();
      current = header.toLowerCase().replace(/[*_`]/g, "").trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Pull markdown bullet items ("- ", "* ", "1. ") from a block of text. */
export function extractBullets(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)\s*$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map((x) => x.replace(/[*_`]/g, "").trim());
}

/**
 * Many team-kit agents have no `#` sections — just a prose body with a
 * "When invoked:" numbered list. Those steps describe what the agent does, so
 * we use them as capabilities when no Success Criteria section exists. Only
 * top-level (un-indented) numbered/bulleted lines are taken; each is reduced to
 * its leading clause.
 */
export function extractWorkflowSteps(body: string): string[] {
  const steps: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent > 3) continue; // skip nested sub-steps
    const m = line.match(/^\s*(?:\d+\.|[-*])\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1]!.replace(/[*_`]/g, "").trim();
    const clause = (text.split(/[.:]\s/)[0] ?? text).trim();
    if (clause.length >= 6) steps.push(clause.length > 140 ? clause.slice(0, 139) + "…" : clause);
  }
  return [...new Set(steps)].slice(0, 10);
}

/** Find a section by trying several candidate header names. */
function pickSection(sections: Record<string, string>, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const key = Object.keys(sections).find((k) => k === c || k.startsWith(c));
    if (key) return sections[key];
  }
  return undefined;
}

/** Known external services we can recognise from free text. Order = display order. */
const SERVICE_SIGNATURES: Array<[label: string, pattern: RegExp]> = [
  ["X API", /\b(x api|twitter|x\.com|tweet|x_bearer)\b/i],
  ["Asana", /\basana\b/i],
  ["investors-mcp", /\binvestors-mcp|queryInvestorContent|streamable.http mcp\b/i],
  ["MCP", /\bmcp\b/i],
  ["Postgres", /\b(postgres|postgresql|neon)\b/i],
  ["Upstash Vector", /\bupstash\b/i],
  ["Vercel Blob", /\bvercel blob|blob_read_write\b/i],
  ["Vercel AI Gateway", /\bai gateway|ai_gateway\b/i],
  ["AWS Bedrock", /\bbedrock\b/i],
  ["LangSmith", /\blangsmith\b/i],
  ["GitHub", /\bgithub\b/i],
  ["OpenAI", /\bopenai\b/i],
  ["Anthropic", /\b(anthropic|claude)\b/i],
];

/** Detect external services mentioned anywhere in the agent text. */
export function detectServices(text: string): string[] {
  const found = new Set<string>();
  for (const [label, pattern] of SERVICE_SIGNATURES) {
    if (pattern.test(text)) found.add(label);
  }
  // "investors-mcp" already implies MCP; avoid double-listing the generic.
  if (found.has("investors-mcp")) found.delete("MCP");
  return [...found];
}

/** Detect team-kit skills referenced in the body (e.g. `skills/apply-engineering-guidelines/`). */
export function detectSkills(text: string): string[] {
  const skills = new Set<string>();
  for (const m of text.matchAll(/skills\/([a-z0-9][a-z0-9-]*)\b/gi)) skills.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\bapply-engineering-guidelines\b/gi)) skills.add(m[0]!.toLowerCase());
  return [...skills];
}

function bulletsToIO(text: string | undefined): IOField[] {
  return extractBullets(text).map((b) => {
    const m = b.match(/^([A-Za-z0-9_.\- ]{1,40}?)\s*[—:-]\s+(.*)$/);
    if (m) return { name: m[1]!.trim(), description: m[2]!.trim() };
    return { name: b };
  });
}

export interface ExtractOptions {
  source: Provenance;
  owner?: { name: string; org?: string; contact?: string };
  repository?: string;
  version?: string;
  license?: string;
}

/**
 * Parse a team-kit agent markdown file into an {@link AgentManifest}.
 * Best-effort: missing sections simply yield empty arrays/strings.
 */
export function parseTeamKitAgent(markdown: string, opts: ExtractOptions): AgentManifest {
  const { data, body } = splitFrontmatter(markdown);
  const sections = extractSections(body);
  const fullText = markdown;

  const id =
    typeof data.name === "string" && data.name.trim()
      ? data.name.trim().toLowerCase()
      : (opts.source.path?.split("/").pop()?.replace(/\.(agent\.)?md$/i, "") ?? "unknown-agent").toLowerCase();

  const description =
    typeof data.description === "string" ? data.description.trim() : pickSection(sections, ["description"]) ?? "";

  const purpose = pickSection(sections, ["goal", "purpose", "personality"]) ?? firstParagraph(body) ?? description;
  let capabilities = extractBullets(pickSection(sections, ["success criteria", "capabilities", "what it does"]));
  if (capabilities.length === 0) capabilities = extractWorkflowSteps(body);
  const triggers = [
    ...extractBullets(pickSection(sections, ["triggers", "when to use"])),
    ...(typeof data.description === "string" ? [String(data.description).trim()] : []),
  ].filter(Boolean);
  const inputs = bulletsToIO(pickSection(sections, ["inputs", "input contract"]));
  const outputs = bulletsToIO(pickSection(sections, ["output", "outputs", "output contract"]));

  const dependencies: Dependencies = {
    services: detectServices(fullText),
    agents: [],
    skills: detectSkills(fullText),
    tools: [],
    dataSources: [],
    packages: [],
  };

  const manifest = AgentManifestSchema.parse({
    id,
    name: prettifyName(id, description),
    version: opts.version ?? "0.0.0",
    description,
    purpose,
    model: typeof data.model === "string" ? data.model : undefined,
    readonly: typeof data.readonly === "boolean" ? data.readonly : undefined,
    owner: opts.owner ?? { name: "Unknown", org: opts.source.location.split("/")[0] },
    repository: opts.repository,
    license: opts.license,
    keywords: [],
    capabilities,
    triggers,
    inputs,
    outputs,
    dependencies,
    documentation: { overview: purpose || undefined },
    source: opts.source,
  });
  return manifest;
}

/** Parse a structured `agent.manifest.yaml` (a serialized AgentManifest). */
export function parseAgentManifestYaml(yamlText: string, source?: Provenance): AgentManifest {
  const raw = parseYaml(yamlText) as Record<string, unknown>;
  const merged = source ? { ...raw, source: raw.source ?? source } : raw;
  return AgentManifestSchema.parse(merged);
}

/** First non-empty, non-heading paragraph of a body (used as a purpose fallback). */
function firstParagraph(body: string): string | undefined {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text || text.startsWith("#") || /^when invoked/i.test(text)) continue;
    return text.replace(/\s+/g, " ").slice(0, 400);
  }
  return undefined;
}

function prettifyName(id: string, description: string): string {
  const pretty = id
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return pretty;
}
