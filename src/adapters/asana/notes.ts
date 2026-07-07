import type { ArticleRecommendation, SuggestedResponse, WatchAuthor, XPost } from "../../ports.js";

/**
 * Asana note + name builders, mirroring the reference
 * `buildAsanaSimilarityTaskNotes` / `buildAsanaRecommendationSubtaskNotes`.
 * The parent task is an information dump; each subtask is a pending approval gate
 * for one (article x prompt) draft and carries an X compose intent link so the
 * operator can post the approved reply in one click.
 */

/** `Draft response: {author} - {header}` */
export function parentTaskName(watch: WatchAuthor, post: XPost): string {
  return `Draft response: ${watch.author} - ${post.header}`;
}

/** `Approve X Reply - {promptLabel}: {articleTitle}` (truncated to 110). */
export function subtaskName(promptLabel: string, articleTitle: string): string {
  return `Approve X Reply - ${truncate(`${promptLabel}: ${articleTitle}`, 110)}`;
}

/** X "compose intent" deep link that pre-fills a reply to the source post. */
export function composeIntentLink(statusId: string, text: string): string {
  const params = new URLSearchParams({ in_reply_to: statusId, text });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

export interface ParentNotesParams {
  watch: WatchAuthor;
  post: XPost;
  recommendations: ArticleRecommendation[];
  topRawScore: number;
  topScore100: number;
  thresholds: { asanaTaskSimilarityThreshold: number; articleSimilarityThreshold: number };
  thresholdMet: boolean;
}

export function buildAsanaSimilarityTaskNotes(p: ParentNotesParams): string {
  const lines: string[] = [];
  lines.push(`Review and approve recommended X replies for a watched-author post.`);
  lines.push("");
  lines.push(`Source post: @${p.post.handle} (${p.watch.author}${p.watch.company ? `, ${p.watch.company}` : ""})`);
  lines.push(`Header: ${p.post.header}`);
  lines.push(`URL: ${p.post.sourceUri}`);
  lines.push(`Status ID: ${p.post.statusId}`);
  if (p.post.kind && p.post.kind !== "post") lines.push(`Engagement: ${p.post.kind}`);
  lines.push("");
  lines.push(
    `Thresholds applied — parent task: ${p.thresholds.asanaTaskSimilarityThreshold}, article recommendation: ${p.thresholds.articleSimilarityThreshold} (raw similarity).`,
  );
  lines.push(`Best match: score ${p.topScore100} (raw ${p.topRawScore.toFixed(4)}) — threshold ${p.thresholdMet ? "met" : "not met"}.`);
  lines.push("");
  lines.push(`Top article matches:`);
  for (const r of p.recommendations) {
    lines.push(`- ${r.title} — score ${r.score100} (raw ${r.rawScore.toFixed(4)})`);
    lines.push(`  ${r.sourceUri}`);
  }
  return lines.join("\n");
}

export interface SubtaskNotesParams {
  recommendation: ArticleRecommendation;
  post: XPost;
  response: SuggestedResponse;
}

export function buildAsanaRecommendationSubtaskNotes(p: SubtaskNotesParams): string {
  const { recommendation: rec, post, response } = p;
  const intent = composeIntentLink(post.statusId, response.text);
  const lines: string[] = [];
  lines.push(`APPROVAL: post this drafted X reply, or request changes.`);
  lines.push("");
  lines.push(`Prompt: ${response.promptLabel}`);
  lines.push(`Instruction: ${response.prompt}`);
  lines.push("");
  lines.push(`Draft reply (${response.text.length} chars):`);
  lines.push(response.text);
  lines.push("");
  lines.push(`Compose on X (pre-filled reply): ${intent}`);
  lines.push("");
  lines.push(`Why recommended: ${rec.whyRecommended}`);
  if (rec.supportingParagraphs.length) {
    lines.push("");
    lines.push(`Supporting passages from the Soofi article:`);
    for (const passage of rec.supportingParagraphs) lines.push(`- ${passage}`);
  }
  lines.push("");
  lines.push(`Source post: ${post.sourceUri} (status ${post.statusId})`);
  lines.push(`Soofi article: ${rec.title}`);
  lines.push(`Article URL: ${rec.sourceUri}`);
  lines.push(`Similarity: raw=${rec.rawScore.toFixed(4)} | score=${rec.score100}`);
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
