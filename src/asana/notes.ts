import type { DraftReplyOutcome } from "../agent/draft-replies";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { InteractionResult } from "../x/interaction";
import type { ParsedPost } from "../x/parse-post";
import { buildXReplyIntentUrl } from "./links";

/**
 * Adapted from investors-mcp's buildAsanaSimilarityTaskNotes for this
 * agent's flatter data shapes (ArticleSimilarity / InteractionResult
 * instead of the reference's nested SoofiArticleRecommendation).
 */
export function buildParentTaskNotes(params: {
  post: ParsedPost;
  interaction: InteractionResult;
  topArticles: ArticleSimilarity[];
  asanaTaskSimilarityThreshold: number;
  articleSimilarityThreshold: number;
  bestCandidateRawScore: number | null;
}): string {
  const {
    post,
    interaction,
    topArticles,
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
    bestCandidateRawScore,
  } = params;

  const lines: string[] = [
    "Source post:",
    post.sourceUri,
    "",
    `Type: ${post.contentType} (${interaction.type})`,
  ];

  if (interaction.referencedStatusId) {
    lines.push(
      "",
      "Referenced original:",
      interaction.referencedAuthorHandle
        ? `@${interaction.referencedAuthorHandle}`
        : "(unknown author)",
      interaction.referencedStatusId,
    );
  }

  lines.push(
    "",
    `Task creation threshold (raw similarity): ${asanaTaskSimilarityThreshold.toFixed(4)}`,
    `Recommendation threshold (raw similarity): ${articleSimilarityThreshold.toFixed(4)}`,
    bestCandidateRawScore !== null
      ? `Best article match before thresholding: ${bestCandidateRawScore.toFixed(4)}`
      : "Best article match before thresholding: (none)",
    "",
    "Top matched Soofi Safavi articles (similarity score: raw + 1-100):",
  );

  if (topArticles.length === 0) {
    lines.push("- none met the similarity threshold");
  } else {
    for (const [index, article] of topArticles.entries()) {
      lines.push(
        `${index + 1}. [raw=${article.rawScore.toFixed(4)} | score=${article.score}] ${article.title}`,
      );
      lines.push(`   ${article.sourceUri}`);
    }
  }

  return lines.join("\n");
}

/**
 * Adapted from investors-mcp's buildAsanaRecommendationSubtaskNotes. A
 * failed draft (outcome.ok === false) still gets a subtask -- visible with
 * its placeholder text and no compose link -- rather than silently
 * disappearing (see docs/implementation-plan.md).
 */
export function buildSubtaskNotes(params: {
  post: ParsedPost;
  article: ArticleSimilarity;
  outcome: DraftReplyOutcome;
}): string {
  const { post, article, outcome } = params;
  const draftText = outcome.ok ? outcome.draft.draftText : outcome.placeholderText;
  const whyRecommended = outcome.ok ? outcome.draft.whyRecommended : "(draft generation failed)";
  const composeUrl = outcome.ok
    ? buildXReplyIntentUrl({ statusId: post.statusId, text: draftText })
    : "";

  return [
    "Approval action:",
    "Approve this task when the drafted reply is ready for manual posting.",
    "",
    "Source post:",
    post.sourceUri || "(none)",
    "",
    "Source status ID:",
    post.statusId || "(none)",
    "",
    "Prompt:",
    outcome.promptLabel,
    outcome.promptText || "(none)",
    "",
    "Draft response:",
    draftText || "(none)",
    ...(composeUrl ? ["", "Open in X:", composeUrl] : []),
    "",
    "Why recommended:",
    whyRecommended,
    "",
    "Soofi article:",
    article.title || "(untitled)",
    article.sourceUri || "(no source)",
    "",
    `Similarity: raw=${article.rawScore.toFixed(4)} | score=${article.score}`,
  ].join("\n");
}
