import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createLangSmithProviderOptions } from "langsmith/experimental/vercel";
import pLimit from "p-limit";
import type { ArticleSimilarity } from "../matching/similarity-gating";
import type { LangSmithFacade } from "../observability/langsmith";
import type { ReplyPromptSlot } from "../prompts/load-prompts";
import type { ParsedPost } from "../x/parse-post";
import { BEDROCK_PROMPT_CACHE_METADATA } from "./bedrock-prompt-cache";
import { DraftReplySchema, type DraftReply } from "./schemas";

const DEFAULT_CONCURRENCY = 4;

export type DraftReplyOutcome =
  | {
      ok: true;
      promptIndex: number;
      promptLabel: string;
      articleSourceUri: string;
      articleTitle: string;
      articleScore: number;
      draft: DraftReply;
    }
  | {
      ok: false;
      promptIndex: number;
      promptLabel: string;
      articleSourceUri: string;
      articleTitle: string;
      articleScore: number;
      placeholderText: string;
      reason: string;
    };

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Enforces the acceptance criteria that a schema alone can't: the character
 * limit (from config, not the schema, since it's operator-tunable), that
 * quotedPhrase is actually grounded in the matched article (near-verbatim
 * substring match, not just "the model says it's a quote"), and the
 * ends-with-a-question rule (or its per-slot override).
 */
export function validateDraftReply(
  draft: DraftReply,
  article: ArticleSimilarity,
  slot: ReplyPromptSlot,
  maxReplyCharacters: number,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (draft.draftText.length > maxReplyCharacters) {
    reasons.push(
      `draftText is ${draft.draftText.length} characters, over the ${maxReplyCharacters} limit`,
    );
  }

  const haystack = normalizeForMatch(article.contextExcerpt || article.excerpt);
  const needle = normalizeForMatch(draft.quotedPhrase);
  if (!needle || !haystack.includes(needle)) {
    reasons.push("quotedPhrase does not appear verbatim in the matched article excerpt");
  }

  if (slot.endsWithQuestion && !draft.draftText.trim().endsWith("?")) {
    reasons.push("draftText must end with a question per this prompt slot");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function buildSystemMessage(systemPrompt: string, constraints: string): string {
  return `${systemPrompt}\n\nGlobal response constraints:\n${constraints}`;
}

function buildUserPrompt(params: {
  post: ParsedPost;
  article: ArticleSimilarity;
  slot: ReplyPromptSlot;
  maxReplyCharacters: number;
  extraInstructions?: string;
}): string {
  const { post, article, slot, maxReplyCharacters, extraInstructions } = params;
  const questionInstruction = slot.endsWithQuestion
    ? "End the reply with a thought-provoking question."
    : "Do not end the reply with a question.";
  const excerpt = article.contextExcerpt || article.excerpt;

  return [
    slot.content,
    "",
    `Keep the reply to at most ${maxReplyCharacters} characters. ${questionInstruction}`,
    "Ground the reply in the matched article excerpt below, and copy a short verbatim phrase from it into quotedPhrase.",
    "",
    `Post being replied to:\n"""\n${post.text}\n"""`,
    "",
    `Matched Soofi Safavi article: "${article.title}" (${article.sourceUri})`,
    `Article excerpt:\n"""\n${excerpt}\n"""`,
    ...(extraInstructions ? ["", extraInstructions] : []),
  ].join("\n");
}

export type GenerateDraftReplyParams = {
  model: LanguageModelV4;
  langsmith: LangSmithFacade;
  systemPrompt: string;
  constraints: string;
  maxReplyCharacters: number;
  post: ParsedPost;
  article: ArticleSimilarity;
  slot: ReplyPromptSlot;
  runKey: string;
};

/**
 * Drafts one reply for one (matched article x prompt-slot) pair. Retries
 * once with a stricter follow-up prompt naming exactly what failed
 * validation; on a second failure, returns a visible placeholder rather
 * than silently dropping the slot (per docs/implementation-plan.md).
 */
export async function generateDraftReply(
  params: GenerateDraftReplyParams,
): Promise<DraftReplyOutcome> {
  const {
    model,
    langsmith,
    systemPrompt,
    constraints,
    maxReplyCharacters,
    post,
    article,
    slot,
    runKey,
  } = params;

  const base = {
    promptIndex: slot.promptIndex,
    promptLabel: slot.promptLabel,
    articleSourceUri: article.sourceUri,
    articleTitle: article.title,
    articleScore: article.score,
  };

  const system = buildSystemMessage(systemPrompt, constraints);
  const providerOptions = {
    langsmith: createLangSmithProviderOptions({
      metadata: {
        session_id: runKey,
        ...BEDROCK_PROMPT_CACHE_METADATA,
        prompt_index: slot.promptIndex,
        prompt_label: slot.promptLabel,
        article_source_uri: article.sourceUri,
        post_source_uri: post.sourceUri,
      },
    }),
  };

  async function attempt(
    extraInstructions?: string,
  ): Promise<{ ok: true; draft: DraftReply } | { ok: false; reasons: string[] }> {
    try {
      const { object } = await langsmith.generateObject({
        model,
        schema: DraftReplySchema,
        system,
        prompt: buildUserPrompt({ post, article, slot, maxReplyCharacters, extraInstructions }),
        providerOptions,
      });
      const validation = validateDraftReply(object, article, slot, maxReplyCharacters);
      return validation.ok
        ? { ok: true, draft: object }
        : { ok: false, reasons: validation.reasons };
    } catch (error) {
      return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
    }
  }

  const first = await attempt();
  if (first.ok) {
    return { ok: true, ...base, draft: first.draft };
  }

  const retry = await attempt(
    `Your previous attempt failed for these reasons: ${first.reasons.join("; ")}. Regenerate, strictly fixing all of them.`,
  );
  if (retry.ok) {
    return { ok: true, ...base, draft: retry.draft };
  }

  return {
    ok: false,
    ...base,
    placeholderText: `LLM generation failed for ${slot.promptLabel}: ${retry.reasons.join("; ")}`,
    reason: retry.reasons.join("; "),
  };
}

export type GenerateDraftRepliesParams = {
  model: LanguageModelV4;
  langsmith: LangSmithFacade;
  systemPrompt: string;
  constraints: string;
  maxReplyCharacters: number;
  post: ParsedPost;
  articles: ArticleSimilarity[];
  replySlots: ReplyPromptSlot[];
  runKey: string;
  concurrency?: number;
};

/**
 * Drafts one reply per (matched article x prompt-slot file) pair, bounded
 * to a small concurrency so a post with several qualifying articles and
 * six-plus prompt slots doesn't fan out unbounded Bedrock calls at once.
 */
export async function generateDraftReplies(
  params: GenerateDraftRepliesParams,
): Promise<DraftReplyOutcome[]> {
  const limit = pLimit(params.concurrency ?? DEFAULT_CONCURRENCY);
  const pairs = params.articles.flatMap((article) =>
    params.replySlots.map((slot) => ({ article, slot })),
  );

  return Promise.all(
    pairs.map(({ article, slot }) =>
      limit(() =>
        generateDraftReply({
          model: params.model,
          langsmith: params.langsmith,
          systemPrompt: params.systemPrompt,
          constraints: params.constraints,
          maxReplyCharacters: params.maxReplyCharacters,
          post: params.post,
          article,
          slot,
          runKey: params.runKey,
        }),
      ),
    ),
  );
}
