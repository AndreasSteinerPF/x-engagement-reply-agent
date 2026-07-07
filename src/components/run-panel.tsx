"use client";

import { useState } from "react";
import type { WebRunResult } from "../web/run-web.js";

interface AuthorOption {
  handle: string;
  author: string;
}

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
      {/* Top progress bar */}
      {loading && (
        <div className="fixed left-0 right-0 top-0 z-50 h-0.5 overflow-hidden">
          <div className="scan-progress-bar h-full w-1/2 bg-amber-400" />
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-amber-400/8 bg-white/[0.02] px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="label">Observe which account</span>
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
          <span>
            Preview only <span className="text-stone-500">(run the full match + draft, skip task creation)</span>
          </span>
        </label>

        <button
          className="ml-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-6 py-2.5 text-base font-medium text-white shadow-lg shadow-amber-500/20 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={executeRun}
          disabled={loading}
        >
          {loading ? "Scanning…" : "Scan now"}
        </button>
      </div>

      {result && !loading && (
        <span className="text-xs text-stone-500">
          via real MCP · {result.mcpEndpoint}
        </span>
      )}

      {/* Divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-amber-400/20 to-transparent" />

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border-l-4 border-red-400 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <span className="font-medium">Something went wrong:</span>
          <span>{error}</span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          <div className="card-elevated h-24 animate-pulse rounded-lg" />
          <div className="card h-16 animate-pulse rounded-lg" />
          <div className="card h-32 animate-pulse rounded-lg" />
          <p className="text-sm text-stone-400">Reading @{author}&apos;s latest posts and checking them against the Soofi corpus…</p>
        </div>
      )}

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
      {/* What happened this run */}
      <div className="card-elevated p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold text-stone-100">What happened this run</h3>
          <span className="chip border-amber-400/40 text-amber-300">{summary.status}</span>
          {summary.dryRun && <span className="chip border-stone-500/20 text-stone-400">preview</span>}
          <span className="text-xs text-stone-500">
            x={result.modes.x} · llm={result.modes.llm} · asana={result.modes.asana} · {summary.durationMs}ms
          </span>
        </div>
        {/* Horizontal stat bar — single container, 7 segments */}
        <div className="flex divide-x divide-amber-400/10 rounded-lg border border-amber-400/8 bg-white/[0.015]">
          <Stat label="Accounts checked" value={m.authorsPolled} />
          <Stat label="Posts pulled" value={m.postsFetched} />
          <Stat label="New posts" value={m.newPostsProcessed} />
          <Stat label="Quoted/replied" value={m.referencedPostsFetched} />
          <Stat label="Articles hit" value={m.articlesMatched} />
          <Stat label="Drafts written" value={m.repliesGenerated} />
          <Stat label="Approvals queued" value={m.asanaSubtasksCreated} />
        </div>
      </div>

      {/* Per-post matches + drafts — accordion */}
      {tasked.map((p) => (
        <PostAccordion key={p.post.statusId} post={p} />
      ))}

      {/* Skipped posts — collapsible */}
      {skipped.length > 0 && <SkippedPosts skipped={skipped} />}

      {/* Approval queue */}
      {asana.length > 0 && (
        <div className="card-elevated p-4">
          <div className="label mb-2">
            Approval queue {summary.dryRun && <span className="text-stone-500">(suppressed in preview)</span>}
          </div>
          {summary.dryRun ? (
            <p className="text-sm text-stone-500">Preview mode: the pipeline ran end-to-end but no tasks were sent to Asana.</p>
          ) : (
            <div className="space-y-4">
              {asana.map((parent, pi) => (
                <div key={pi}>
                  {/* Parent node */}
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-amber-400/40 bg-amber-400/10 text-[10px] text-amber-300" aria-hidden>
                      ●
                    </span>
                    <span className="text-sm font-medium text-stone-200">{parent.name}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-xs text-stone-500">
                    <span>similarity {parent.topScore100}/100 · {parent.subtasks.length} drafts awaiting review · assigned to {parent.assignee}</span>
                    {parent.dueToday && <span className="chip border-orange-400/40 text-orange-300">due today</span>}
                  </div>
                  {/* Subtask branches */}
                  <ul className="mt-2 ml-[9px] space-y-1.5 border-l-2 border-amber-400/20 pl-4">
                    {parent.subtasks.map((s, si) => (
                      <li key={si} className="flex flex-wrap items-center gap-2 text-sm text-stone-300">
                        <span className="text-stone-500">↳</span>
                        <span>{s.name}</span>
                        <a href={s.composeUrl} target="_blank" rel="noreferrer noopener" className="link text-xs">
                          open in X ↗
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

      {/* Draft generation log */}
      {traces.length > 0 && (
        <div className="card-elevated p-4">
          <div className="label mb-2">Draft generation log ({traces.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-amber-400/10 text-left text-xs uppercase tracking-wider text-stone-500">
                  <th className="py-1.5 pr-3 font-semibold">Provider / model</th>
                  <th className="py-1.5 pr-3 font-semibold">Prompts</th>
                  <th className="py-1.5 pr-3 font-semibold">In/out chars</th>
                  <th className="py-1.5 pr-3 font-semibold">Duration</th>
                  <th className="py-1.5 font-semibold">OK</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t, i) => (
                  <tr key={i} className="border-b border-amber-400/5 last:border-0 even:bg-white/[0.02]">
                    <td className="py-1.5 pr-3 font-mono text-xs text-stone-300">
                      {t.provider}/{t.model}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-300">{t.promptCount}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-400">
                      {t.inputChars}/{t.outputChars}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-stone-400">{t.durationMs}ms</td>
                    <td className={`py-1.5 pl-3 border-l-2 ${t.ok ? "border-l-green-400/40" : "border-l-red-400/40"}`}>
                      {t.ok ? <span className="text-green-400">✓</span> : <span className="text-red-400">✕</span>}
                    </td>
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

function PostAccordion({ post: p }: { post: import("../pipeline/run.js").ProcessedPostRecord }) {
  const [open, setOpen] = useState(true);
  const bestScore = p.matches[0]?.score100 ?? 0;

  return (
    <div className="card-elevated overflow-hidden">
      {/* Row header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-amber-400/5"
      >
        <span className="text-sm font-medium text-stone-200">@{p.post.handle}</span>
        <span className="font-mono text-xs text-stone-500">{p.post.statusId}</span>
        {bestScore > 0 && (
          <span className="inline-flex items-center rounded bg-amber-500/15 px-1.5 font-mono text-xs text-amber-200">
            best {bestScore}
          </span>
        )}
        <span className="chip border-amber-400/30 text-amber-200">{p.recommendations.length} match{p.recommendations.length !== 1 ? "es" : ""}</span>
        {p.isReferenced && <span className="chip border-amber-400/30 text-amber-200">referenced original</span>}
        {p.post.kind && p.post.kind !== "post" && <span className="chip border-stone-500/20 text-stone-400">{p.post.kind}</span>}
        <a href={p.post.sourceUri} target="_blank" rel="noreferrer noopener" className="link text-xs" onClick={(e) => e.stopPropagation()}>
          source ↗
        </a>
        <span className="ml-auto text-xs text-stone-500">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-amber-400/8 px-4 py-4">
          <p className="text-sm leading-relaxed text-stone-300">{p.post.text}</p>

          {/* Article matches — definition-list style */}
          <div className="border-l-2 border-amber-400/20 pl-4">
            <div className="label mb-2">Relevant excerpts</div>
            <ul className="space-y-3">
              {p.matches.slice(0, 5).map((a, i) => (
                <li key={i} className="space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="inline-flex shrink-0 items-center rounded bg-amber-500/15 px-1.5 font-mono text-xs text-amber-200">
                      {a.score100}
                    </span>
                    <span className="text-stone-300">{a.title}</span>
                    <span className="text-xs text-stone-500">· raw {a.rawScore.toFixed(4)}</span>
                  </div>
                  {/* Score bar */}
                  <div className="h-1 w-full overflow-hidden rounded-full bg-stone-700/40">
                    <div className="h-full rounded-full bg-amber-400/50" style={{ width: `${a.score100}%` }} />
                  </div>
                  {/* Supporting passages */}
                  {a.supportingParagraphs.length > 0 && (
                    <ul className="mt-1 space-y-1 pl-3">
                      {a.supportingParagraphs.map((para, pi) => (
                        <li key={pi} className="border-l border-amber-400/10 pl-2 text-xs italic text-stone-500">
                          {para}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Draft replies — left accent panels */}
          <div className="space-y-3">
            {p.recommendations.map((rec, ri) => (
              <div key={ri}>
                <div className="mb-2 text-sm font-medium text-stone-200">
                  {rec.title} <span className="text-xs font-normal text-stone-500">· score {rec.score100} · {rec.suggestedResponses.length} drafts</span>
                </div>
                <div className="space-y-2">
                  {rec.suggestedResponses.map((r) => (
                    <div key={r.promptIndex} className="border-l-2 border-amber-400/40 pl-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="chip border-amber-400/30 text-amber-200">{r.promptLabel}</span>
                        <span className="text-[11px] text-stone-500">{r.text.length} of 280 characters</span>
                        <a
                          href={`https://twitter.com/intent/tweet?in_reply_to=${p.post.statusId}&text=${encodeURIComponent(r.text)}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="link ml-auto text-xs"
                        >
                          Draft on X ↗
                        </a>
                      </div>
                      <p className="text-sm leading-relaxed text-stone-200">{r.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SkippedPosts({ skipped }: { skipped: import("../pipeline/run.js").ProcessedPostRecord[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs text-stone-500 transition-colors hover:text-stone-400"
      >
        <span className="label">Filtered out — below threshold</span>
        <span className="text-stone-600">· {skipped.length} post{skipped.length !== 1 ? "s" : ""}</span>
        <span className="ml-auto text-stone-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-xs text-stone-500">
          {skipped.map((p) => (
            <li key={p.post.statusId}>
              @{p.post.handle}/{p.post.statusId} — {p.reason ?? "nothing matched strongly enough"}
              {p.matches[0] && <span className="text-stone-600"> · best {p.matches[0].score100} (raw {p.matches[0].rawScore.toFixed(4)})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex-1 px-3 py-2.5 text-center">
      <div className="text-[11px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-stone-100">{value}</div>
    </div>
  );
}
