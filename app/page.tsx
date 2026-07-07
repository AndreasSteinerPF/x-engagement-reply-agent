import { loadConfig } from "@/config/load";
import { DEFAULT_MCP_URL } from "@/mcp/client";
import { RunPanel } from "@/components/run-panel";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = await loadConfig({ rootDir: process.cwd() });
  const active = config.watchlist.filter((a) => a.active);
  const authors = active.map((a) => ({ handle: a.handle, author: a.author }));
  const defaultAuthor = authors.find((a) => a.handle === "balajis")?.handle ?? authors[0]?.handle ?? "";
  const s = config.settings;
  const mcpEndpoint = process.env.MCP_URL ?? DEFAULT_MCP_URL;

  return (
    <>
      {/* ── Sidebar ── */}
      <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col overflow-y-auto border-r border-amber-400/10 bg-white/[0.02]">
        <div className="flex-1 space-y-6 px-5 py-6">
          {/* Identity */}
          <div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-amber-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
              </span>
              <h2 className="text-lg font-bold tracking-tight text-stone-100">Kestrel</h2>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">
              Watches X authors, matches posts to the Soofi corpus, drafts replies for human approval.
            </p>
          </div>

          {/* MCP endpoint */}
          <div className="card-compact flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-green-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            <span className="font-mono text-[11px] text-stone-400">{mcpEndpoint}</span>
          </div>

          {/* How it's wired */}
          <div className="space-y-3">
            <div>
              <h3 className="label">How it&apos;s wired</h3>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                There&apos;s no settings page and no database. Every knob — who to watch, when to poll, how strict to
                be, what tone to reply in — lives in YAML and Markdown files that go through code review. Want to change
                something? Open a PR.
              </p>
            </div>

            {/* Accounts under observation */}
            <div>
              <div className="label mb-1.5">Accounts under observation</div>
              <ul className="space-y-0.5">
                {config.watchlist.map((a) => (
                  <li
                    key={a.handle}
                    className={`flex items-center gap-2 rounded-md px-2 py-1 -mx-2 transition-colors hover:bg-amber-400/5 ${a.active ? "border-l-2 border-amber-400" : "border-l-2 border-stone-600"}`}
                  >
                    <span className="text-sm text-stone-200">{a.author}</span>
                    <span className="text-xs text-stone-500">@{a.handle}</span>
                    {a.company && <span className="text-[11px] text-stone-600">· {a.company}</span>}
                    {!a.active && <span className="text-[11px] text-stone-600">(inactive)</span>}
                  </li>
                ))}
              </ul>
            </div>

            {/* Tuning parameters */}
            <div>
              <div className="label mb-1.5">Tuning parameters</div>
              <dl className="divide-y divide-amber-400/5">
                <Setting k="Parent-task similarity" v={s.asanaTaskSimilarityThreshold} />
                <Setting k="Article recommendation" v={s.articleSimilarityThreshold} />
                <Setting k="Top-K matches" v={s.defaultTopK} />
                <Setting k="Batch size" v={s.defaultBatchSize} />
                <Setting k="Max posts / author" v={s.defaultMaxPostsPerAuthor} />
                <Setting k="Poll interval (min)" v={s.pollIntervalMinutes} />
                <Setting k="Model" v={s.modelId} />
                <Setting k="Excluded authors" v={s.excludeAuthors.join(", ") || "—"} />
              </dl>
            </div>

            {/* Reply strategies */}
            <div>
              <div className="label mb-1.5">Reply strategies</div>
              <ol className="space-y-0">
                {config.replyPrompts.map((p, i) => (
                  <li key={p.index} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < config.replyPrompts.length - 1 && (
                      <span className="absolute left-[11px] top-6 h-[calc(100%-12px)] w-px bg-amber-400/15" aria-hidden />
                    )}
                    <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-400/30 bg-stone-900 font-mono text-[11px] text-amber-300">
                      {p.index}
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <div className="text-sm text-stone-200">{p.label}</div>
                      <div className="truncate font-mono text-[11px] text-stone-600">{p.file}</div>
                      {!p.requireQuestion && (
                        <span className="chip mt-1 border-stone-500/20 text-stone-500">no-question override</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs leading-relaxed text-stone-500">
                Spin up a new reply style by adding a file to <code className="text-stone-400">prompts/replies/</code>.
                The agent picks it up on the next deploy.
              </p>
            </div>
          </div>
        </div>

        {/* Footer in sidebar bottom */}
        <footer className="border-t border-amber-400/5 px-5 py-4 text-xs text-stone-600">
          Kestrel — built by Andreas Steiner · X engagement, reviewed
        </footer>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1">
        <div className="mx-auto max-w-4xl px-8 py-10">
          {/* Hero band */}
          <header className="mb-8 border-b border-amber-400/10 py-8">
            <h1 className="text-4xl font-bold tracking-tight text-stone-100">Kestrel</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-stone-400">
              Every few minutes, Kestrel checks in on a curated list of X accounts. When someone posts something that
              overlaps with Soofi&apos;s published ideas, it lines up a draft reply — grounded in the specific article
              that matches — and queues it behind an approval gate. You review, you edit, you decide what goes live.
              Nothing ships without you.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="chip border-amber-400/40 text-amber-300">no login required — try it instantly</span>
              <span className="chip border-stone-500/20 text-stone-400">sample posts</span>
              <span className="chip border-stone-500/20 text-stone-400">offline drafts — same output every time</span>
              <span className="chip border-green-400/30 text-green-300">
                <span className="relative mr-1 flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-green-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                </span>
                live semantic search → {mcpEndpoint}
              </span>
            </div>
          </header>

          {/* Run surface */}
          <RunPanel authors={authors} defaultAuthor={defaultAuthor} />
        </div>
      </main>
    </>
  );
}

function Setting({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <dt className="text-xs text-stone-500">{k}</dt>
      <dd className="font-mono text-xs text-stone-300">{String(v)}</dd>
    </div>
  );
}
