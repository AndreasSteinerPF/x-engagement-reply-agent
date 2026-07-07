import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WatchAuthor, XClient, XPost } from "../../ports.js";

interface FixtureReference {
  handle: string;
  author: string;
  statusId: string;
  header?: string;
  text: string;
  kind?: XPost["kind"];
  createdAt?: string;
  sourceUri?: string;
  articleText?: string;
}

interface FixturePost {
  statusId: string;
  header?: string;
  text: string;
  kind?: XPost["kind"];
  createdAt?: string;
  sourceUri?: string;
  articleText?: string;
  references?: FixtureReference[];
}

interface FixtureFile {
  handle: string;
  author: string;
  posts: FixturePost[];
}

/**
 * Fixture-backed {@link XClient}. Reads `<fixturesDir>/<handle>.json` per author,
 * returns posts newest-first, and resolves referenced originals from each post's
 * `references` array. This is the default source when no X API credentials are
 * present — it lets the entire pipeline run deterministically and offline, which
 * is exactly the "local/isolated testing without side effects" mode the brief
 * calls for. {@link LiveXClient} is the credentialed production swap.
 */
export class FixtureXClient implements XClient {
  private readonly referencesByStatusId = new Map<string, XPost[]>();

  constructor(private readonly fixturesDir: string) {}

  async fetchLatestPosts(author: WatchAuthor, max: number): Promise<XPost[]> {
    const handles = [author.handle, ...author.aliases.handles].map((h) => h.replace(/^@/, ""));
    for (const handle of handles) {
      const file = join(this.fixturesDir, `${handle}.json`);
      if (!existsSync(file)) continue;
      const data = JSON.parse(await readFile(file, "utf8")) as FixtureFile;
      const posts = data.posts.map((p) => this.toPost(data, p));
      // newest first by numeric status id
      posts.sort((a, b) => compareStatusIds(b.statusId, a.statusId));
      return posts.slice(0, max);
    }
    return [];
  }

  async fetchReferencedPosts(post: XPost): Promise<XPost[]> {
    return this.referencesByStatusId.get(post.statusId) ?? [];
  }

  private toPost(file: FixtureFile, p: FixturePost): XPost {
    const handle = file.handle.replace(/^@/, "");
    const post: XPost = {
      statusId: p.statusId,
      sourceUri: p.sourceUri ?? `https://x.com/${handle}/status/${p.statusId}`,
      handle,
      author: file.author,
      header: p.header ?? deriveHeader(p.text),
      text: p.text,
      kind: p.kind ?? "post",
      createdAt: p.createdAt,
      articleText: p.articleText,
    };
    if (p.references?.length) {
      const refs = p.references.map((r) => this.toReference(r, post.statusId));
      this.referencesByStatusId.set(post.statusId, refs);
    }
    return post;
  }

  private toReference(r: FixtureReference, referencedByStatusId: string): XPost {
    const handle = r.handle.replace(/^@/, "");
    return {
      statusId: r.statusId,
      sourceUri: r.sourceUri ?? `https://x.com/${handle}/status/${r.statusId}`,
      handle,
      author: r.author,
      header: r.header ?? deriveHeader(r.text),
      text: r.text,
      kind: r.kind ?? "post",
      createdAt: r.createdAt,
      articleText: r.articleText,
      referencedByStatusId,
    };
  }
}

/** Compare two big-integer status-id strings without precision loss. */
export function compareStatusIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function deriveHeader(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + "…" : firstSentence;
}
