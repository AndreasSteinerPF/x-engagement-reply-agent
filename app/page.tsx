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
    <div className="space-y-8">
      {/* Header */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Kestrel</h1>
          <span className="chip border-stone-500/20 text-stone-400">X Engagement Reply Agent</span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-stone-300">
          Polls watched X authors, matches each new post against Soofi Safavi article content via the{" "}
          <span className="text-stone-100">hosted investors-mcp MCP</span> (real semantic similarity), drafts one
          recommended reply per code-managed prompt file, and prepares Asana parent + approval subtasks (with X compose
          links) for a human to review and post. No autonomous posting; every reply is a pending approval gate.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-stone-500">
          <span className="chip border-amber-400/40 text-amber-300">credential-free — exercisable with no setup</span>
          <span>x source: fixtures</span>
          <span aria-hidden>·</span>
          <span>reply drafting: deterministic (offline)</span>
          <span aria-hidden>·</span>
          <span>article matching: real MCP → {mcpEndpoint}</span>
        </div>
      </header>

      {/* Run surface */}
      <RunPanel authors={authors} defaultAuthor={defaultAuthor} />

      {/* Code-managed configuration (loaded from version-controlled files) */}
      <section className="space-y-4">
        <div>
          <h2 className="label">Code-managed configuration</h2>
          <p className="mt-1 text-xs text-stone-500">
            All operational behaviour is loaded from version-controlled files — no admin UI, no database. Edit{" "}
            <code className="text-stone-400">config/*.yaml</code> and <code className="text-stone-400">prompts/**/*.md</code>, redeploy.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Watchlist */}
          <div className="card p-4">
            <div className="label mb-2">Watchlist ({active.length} active)</div>
            <ul className="space-y-1.5 text-sm">
              {config.watchlist.map((a) => (
                <li key={a.handle} className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${a.active ? "bg-amber-400" : "bg-stone-600"}`} />
                  <span className="text-stone-200">{a.author}</span>
                  <span className="text-stone-500">@{a.handle}</span>
                  {a.company && <span className="text-xs text-stone-600">· {a.company}</span>}
                  {!a.active && <span className="text-xs text-stone-600">(inactive)</span>}
                </li>
              ))}
            </ul>
          </div>

          {/* Thresholds & settings */}
          <div className="card p-4">
            <div className="label mb-2">Settings &amp; thresholds</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
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
        </div>

        {/* Reply prompt slots */}
        <div className="card p-4">
          <div className="label mb-2">Reply prompt slots ({config.replyPrompts.length}, one file each)</div>
          <ul className="space-y-1.5 text-sm">
            {config.replyPrompts.map((p) => (
              <li key={p.index} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-amber-400/5 font-mono text-xs text-stone-400">
                  {p.index}
                </span>
                <span className="text-stone-200">{p.label}</span>
                <span className="font-mono text-xs text-stone-600">{p.file}</span>
                {!p.requireQuestion && <span className="chip border-stone-500/20 text-stone-500">no-question override</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            Add a 6th slot by dropping a new <code className="text-stone-400">prompts/replies/06-*.md</code> file — no code change.
          </p>
        </div>
      </section>
    </div>
  );
}

function Setting({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-stone-500">{k}</dt>
      <dd className="font-mono text-xs text-stone-300">{String(v)}</dd>
    </div>
  );
}
