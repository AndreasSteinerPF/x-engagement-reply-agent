import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { runWeb } from "@/web/run-web";

// Always run on demand (reads code-managed config + calls the live MCP).
export const dynamic = "force-dynamic";
// Article matching calls the hosted MCP (a few seconds each) — give the run room.
export const maxDuration = 60;

/**
 * Execute one polling pass of the agent and return the full result for the
 * browser to render: the run summary, the per-post matches + drafts, the
 * would-be Asana approval tasks (with X compose links), and the LLM traces.
 *
 * This is also the endpoint the Agent Network Platform calls for its "Run agent"
 * action (A→B): it POSTs `{ dryRun, author }` and ingests the returned summary.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; author?: string };
    const result = await runWeb({
      dryRun: Boolean(body.dryRun),
      author: typeof body.author === "string" && body.author.trim() ? body.author.trim() : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "run failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
