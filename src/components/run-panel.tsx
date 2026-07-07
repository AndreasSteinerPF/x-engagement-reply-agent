"use client";

import { useState } from "react";
import type { WebRunResult } from "../web/run-web.js";

interface AuthorOption {
  handle: string;
  author: string;
}

/**
 * The interactive run surface: pick a watched author, toggle dry-run, and run
 * the agent on its deployed runtime. Renders the live outcome the reviewer cares
 * about — real similarity scores, a draft per prompt file, the would-be Asana
 * approval tasks with X compose links, and the LLM traces.
 */
export function RunPanel({ authors, defaultAuthor }: { authors: AuthorOption[]; defaultAuthor: string }) {
  const [author, setAuthor] = useState(defaultAuthor);
  const [dryRun, setDryRun] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<WebRunResult>();

  async function executeRun() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author, dryRun }),
      });
      const j = (await res.json()) as ({ ok: true } & WebRunResult) | { ok: false; error: string };
      if (!res.ok || !j.ok) {
        setError("error" in j ? j.error : `Run failed (${res.status})`);
      } else {
        setResult(j);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-5">
      {/* Controls */}
      <div className="card flex flex-wrap items-end gap-4 p-4">
        <label className="flex flex-col gap-1">
          <span className="label">Watched author</span>
          <select
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="rounded-lg border border-amber-400/10 bg-white/[0.04] px-3 py-1.5 text-sm text-stone-200 focus:border-amber-400/40 focus:outline-none"
          >
            {authors.map((a) => (
              <option key={a.handle} value={a.handle} className="bg-stone-900">
                {a.author} (@{a.handle})
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-300">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="h-4 w-4 accent-amber-500" />
          Dry-run <span className="text-stone-500">(match + draft, no Asana tasks)</span>
        </label>

        <button className="btn-primary" onClick={executeRun} disabled={loading}>
          {loading ? "Running…" : "▶ Run agent"}
        </button>

        {result && !loading && (
          <span className="text-xs text-stone-500">
            via real MCP · {result.mcpEndpoint}
          </span>
        )}
      </div>

      {error && (
        <div className="card border-red-400/30 p-4 text-sm text-red-300">
          <span className="font-medium">Run failed:</span> {error}
        </div>
      )}

      {loading && <p className="text-sm text-stone-400">Polling @{author}, matching against the Soofi corpus via the live MCP…</p>}

      {result && !loading && <RunOutcome result={result} />}
    </section>
  );
}

function RunOutcome({ result }: { result: WebRunResult }) {
  const { summary, artifact, asana, traces } = result;
  const m = summary.metrics;
  const tasked = artifact.posts.filter((p) => p.recommendations.length > 0);
  const skipped = artifact.posts.filter((p) => p.recommendations.length === 0);

  return (
    <div className="space-y-6">
      {/* Run summary */}
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold text-stone-100">Run summary</h3>
          <span className={`chip ${summary.status === "success" ? "border-amber-400/40 text-amber-300" : "border-amber-400/40 text-amber-300"}`}>
            {summary.status}
          </span>
          {summary.dryRun && <span className="chip border-stone-500/20 text-stone-400">dry-run</span>}
          <span className="text-xs text-stone-500">
            x={result.modes.x} · llm={result.modes.llm} · asana={result.modes.asana} · {summary.durationMs}ms
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatCard label="Authors" value={m.authorsPolled} />
          <StatCard label="Fetched" value={m.postsFetched} />
          <StatCard label="New" value={m.newPostsProcessed} />
          <StatCard label="Referenced" value={m.referencedPostsFetched} />
          <StatCard label="Matched" value={m.articlesMatched} />
          <StatCard label="Replies" value={m.repliesGenerated} />
          <StatCard label="Subtasks" value={m.asanaSubtasksCreated} />
        </div>
      </div>

      {/* Per-post matches + drafts */}
      {tasked.map((p) => (
        <div key={p.post.statusId} className="card p-4">
          <div className="mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip border-stone-500/20 text-stone-300">@{p.post.handle}</span>
              {p.isReferenced && <span className="chip border-amber-400/30 text-amber-200">referenced original</span>}
              {p.post.kind && p.post.kind !== "post" && <span className="chip border-stone-500/20 text-stone-400">{p.post.kind}</span>}
              <a href={p.post.sourceUri} target="_blank" rel="noreferrer noopener" className="link text-xs">
                source ↗
              </a>
            </div>
            <p className="mt-2 text-sm text-stone-300">{p.post.text}</p>
          </div>

          {/* Matches with similarity scores */}
          <div className="mb-3">
            <div className="label mb-1.5">Soofi article matches (real MCP similarity)</div>
            <ul className="space-y-1.5">
              {p.matches.slice(0, 5).map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 inline-flex shrink-0 items-center rounded bg-amber-500/15 px-1.5 font-mono text-xs text-amber-200">
                    {a.score100}
                  </span>
                  <span className="text-stone-300">
                    {a.title} <span className="text-stone-500">· raw {a.rawScore.toFixed(4)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Drafted replies — one per prompt file per qualifying article */}
          {p.recommendations.map((rec, ri) => (
            <div key={ri} className="mt-3 rounded-lg border border-amber-400/10 bg-white/[0.02] p-3">
              <div className="mb-2 text-sm font-medium text-stone-200">
                {rec.title} <span className="text-xs font-normal text-stone-500">· score {rec.score100} · {rec.suggestedResponses.length} drafts</span>
              </div>
              <div className="space-y-2">
                {rec.suggestedResponses.map((r) => (
                  <div key={r.promptIndex} className="rounded-md border border-amber-400/5 bg-black/20 p-2.5">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="chip border-amber-400/30 text-amber-200">{r.promptLabel}</span>
                      <span className="text-[11px] text-stone-500">{r.text.length}/280</span>
                      <a
                        href={`https://twitter.com/intent/tweet?in_reply_to=${p.post.statusId}&text=${encodeURIComponent(r.text)}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="link ml-auto text-xs"
                      >
                        Compose on X ↗
                      </a>
                    </div>
                    <p className="text-sm text-stone-200">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Skipped posts (below-threshold / excluded) — shows the gate working */}
      {skipped.length > 0 && (
        <div className="card p-4">
          <div className="label mb-2">Skipped (gate not met)</div>
          <ul className="space-y-1 text-sm text-stone-400">
            {skipped.map((p) => (
              <li key={p.post.statusId}>
                @{p.post.handle}/{p.post.statusId} — {p.reason ?? "no qualifying article"}
                {p.matches[0] && <span className="text-stone-600"> · best {p.matches[0].score100} (raw {p.matches[0].rawScore.toFixed(4)})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Would-be Asana approval tasks */}
      {asana.length > 0 && (
        <div className="card p-4">
          <div className="label mb-2">Would-be Asana approval tasks {summary.dryRun && <span className="text-stone-500">(suppressed in dry-run)</span>}</div>
          {summary.dryRun ? (
            <p className="text-sm text-stone-500">Dry-run: matching + drafting ran, but no Asana parent/subtasks were created.</p>
          ) : (
            <div className="space-y-3">
              {asana.map((parent, pi) => (
                <div key={pi} className="rounded-lg border border-amber-400/10 bg-white/[0.02] p-3">
                  <div className="text-sm font-medium text-stone-200">📋 {parent.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                    <span>parent · score {parent.topScore100} · {parent.subtasks.length} approval subtasks</span>
                    <span aria-hidden>·</span>
                    <span>assignee: {parent.assignee}</span>
                    {parent.dueToday && <span className="chip border-orange-400/40 text-orange-300">due today</span>}
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {parent.subtasks.map((s, si) => (
                      <li key={si} className="flex flex-wrap items-center gap-2 text-sm text-stone-300">
                        <span className="text-stone-500">↳</span>
                        <span>{s.name}</span>
                        <a href={s.composeUrl} target="_blank" rel="noreferrer noopener" className="link text-xs">
                          compose ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* LLM traces */}
      {traces.length > 0 && (
        <div className="card p-4">
          <div className="label mb-2">LLM reply-generation traces ({traces.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-amber-400/10 text-left text-xs text-stone-500">
                  <th className="py-1.5 pr-3 font-medium">Provider / model</th>
                  <th className="py-1.5 pr-3 font-medium">Prompts</th>
                  <th className="py-1.5 pr-3 font-medium">In/out chars</th>
                  <th className="py-1.5 pr-3 font-medium">Duration</th>
                  <th className="py-1.5 font-medium">OK</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t, i) => (
                  <tr key={i} className="border-b border-amber-400/5 last:border-0">
                    <td className="py-1.5 pr-3 font-mono text-xs text-stone-300">
                      {t.provider}/{t.model}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-300">{t.promptCount}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-400">
                      {t.inputChars}/{t.outputChars}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-400">{t.durationMs}ms</td>
                    <td className="py-1.5">{t.ok ? <span className="text-amber-400">✓</span> : <span className="text-red-400">✕</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-amber-400/5 bg-white/[0.02] px-3 py-2">
      <div className="label">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-stone-100">{value}</div>
    </div>
  );
}
