import type {
  ReplyGenerationInput,
  ReplyGenerationOutput,
  ReplyGenerator,
  SuggestedResponse,
} from "../../ports.js";

const CHAR_LIMIT = 280;

/**
 * Deterministic, offline reply generator — the default when no LLM provider
 * credentials are present. It produces grounded drafts without a network call:
 * every reply quotes a real phrase from the matched Soofi article, varies its
 * framing per prompt slot, respects the 280-character limit, and ends with a
 * thought-provoking question unless the prompt sets `requireQuestion: false`.
 *
 * It is intentionally not as fluent as a real model, but it is correct,
 * reproducible, and fully testable — and swapping in {@link LlmReplyGenerator}
 * is a one-env-var change. The run is traced identically either way.
 */
export class DeterministicReplyGenerator implements ReplyGenerator {
  readonly provider = "offline-deterministic";
  readonly model = "offline/grounded-v1";

  async generate(input: ReplyGenerationInput): Promise<ReplyGenerationOutput> {
    const startedAt = new Date().toISOString();
    const start = performance.now();

    const quote = pickQuote(input.article.contextExcerpt, input.article.supportingParagraphs);
    const theme = pickTheme(input.article.title);

    const responses: SuggestedResponse[] = input.prompts.map((p) => {
      const mode = inferMode(p.label, p.text);
      const closer = p.requireQuestion ? pickQuestion(p.index, theme) : pickCallToAction(theme);
      const text = compose(mode, quote, closer);
      return { promptIndex: p.index, promptLabel: p.label, prompt: p.text, text };
    });

    const whyRecommended = clampWords(
      `Both the post and this Soofi article center on ${theme}; the article makes the case directly and supplies quotable language to ground a reply.`,
      35,
    );

    const finishedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - start);
    const outputChars = responses.reduce((n, r) => n + r.text.length, 0) + whyRecommended.length;
    const inputChars =
      input.systemPrompt.length +
      input.responseConstraints.join("").length +
      input.article.contextExcerpt.length +
      input.post.text.length +
      input.prompts.reduce((n, p) => n + p.text.length, 0);

    return {
      whyRecommended,
      responses,
      trace: {
        provider: this.provider,
        model: this.model,
        startedAt,
        finishedAt,
        durationMs,
        promptCount: input.prompts.length,
        inputChars,
        outputChars,
        ok: true,
      },
    };
  }
}

type Mode = "recommend" | "agree" | "counter" | "example" | "thesis";

function inferMode(label: string, text: string): Mode {
  const hay = `${label} ${text}`.toLowerCase();
  if (/counter|challenge|disagree|qualify/.test(hay)) return "counter";
  if (/agree|extend|affirm/.test(hay)) return "agree";
  if (/example|concrete|mechanism|tangible/.test(hay)) return "example";
  if (/thesis|claim|declarative|sharpest/.test(hay)) return "thesis";
  return "recommend";
}

/** Wrap the quoted phrase: period inside for a complete phrase, none after an ellipsis. */
function quoteBlock(quote: string): string {
  const inner = quote.endsWith("…") ? quote : `${quote}.`;
  return `“${inner}”`;
}

function compose(mode: Mode, quote: string, closer: string): string {
  const lead: Record<Mode, string> = {
    recommend: "Soofi's argument fits here:",
    agree: "Agreed — and Soofi pushes it further:",
    counter: "Fair, though Soofi would qualify it:",
    example: "Concretely, as Soofi puts it:",
    thesis: "",
  };
  const head = lead[mode] ? `${lead[mode]} ${quoteBlock(quote)}` : quoteBlock(quote);
  return fitToLimit(`${head} ${closer}`, quote, closer, mode);
}

/** Ensure the composed reply fits in 280 chars, trimming the quote on a word boundary first. */
function fitToLimit(full: string, quote: string, closer: string, mode: Mode): string {
  if (full.length <= CHAR_LIMIT) return full;
  const overflow = full.length - CHAR_LIMIT;
  // Trim the quote back to a whole word, then mark the elision with an ellipsis.
  const trimmed = quote
    .slice(0, Math.max(0, quote.length - overflow - 2))
    .replace(/\s+\S*$/, "")
    .replace(/[.,;:—-]+$/, "")
    .trimEnd();
  if (trimmed.length >= 12) {
    const rebuilt = compose(mode, `${trimmed}…`, closer);
    if (rebuilt.length <= CHAR_LIMIT) return rebuilt;
  }
  // Fall back to a hard cut on a word boundary.
  return full.slice(0, CHAR_LIMIT - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
}

/** Pick a short, quotable phrase from the article content (never cut mid-word). */
export function pickQuote(excerpt: string, passages: string[]): string {
  const source = (passages[0] ?? excerpt).replace(/\s+/g, " ").trim();
  const sentences = source
    .split(/(?<=[.!?])\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 180 && !/^#/.test(s));
  let chosen = sentences[0];
  if (!chosen) {
    // No clean sentence — prefer the first clause, else a word-bounded slice.
    const clause = (source.split(/[,;:]/)[0] ?? "").trim();
    chosen = clause.length >= 20 && clause.length <= 160 ? clause : source.slice(0, 150).replace(/\s+\S*$/, "").trim();
  }
  return chosen.replace(/[.!?]+$/, "").replace(/^["“”']+|["“”']+$/g, "").trim();
}

/**
 * A clean, concise noun-phrase derived from the article title — used as a topic
 * label in the closing question, the "why recommended" line, and the CTA. We
 * stop at the first verb/modal so the phrase stays grammatical when slotted into
 * a sentence (e.g. "Privacy-First Property Tokenization MUST separate…" →
 * "privacy-first property tokenization", not "…tokenization must separate digital").
 */
export function pickTheme(title: string): string {
  const cleaned = title
    .replace(/^core principle:?\s*/i, "")
    .replace(/[.:].*$/, "")
    .toLowerCase()
    .trim();
  const stop = new Set([
    "must", "should", "will", "can", "may", "is", "are", "be", "needs", "need",
    "separate", "requires", "require", "means", "breaks", "break", "enables", "enable", "that", "which",
  ]);
  const phrase: string[] = [];
  for (const w of cleaned.split(/\s+/)) {
    if (stop.has(w)) break;
    phrase.push(w);
    if (phrase.length >= 4) break;
  }
  return phrase.join(" ").replace(/[-,]$/, "") || "verifiable property data";
}

// Self-contained, grammatical questions. They reference the post's idea via
// "this" contextually (the reply already quotes the article), so we never splice
// a raw title fragment into them — that produced broken grammar like
// "…make privacy-first property tokenization must separate digital real at scale?".
const QUESTIONS = [
  "What breaks first if we keep pretending the old system is fine?",
  "How would your model change if this were verifiable end to end?",
  "Who should actually own this layer once it exists?",
  "What would it take to make this real at scale?",
  "Where does this leave the incumbents who depend on the silo?",
  "What's the first record you'd want provable on-chain?",
];

function pickQuestion(index: number, theme: string): string {
  // `theme` is intentionally unused in the question now (kept in the signature
  // for the grounded `whyRecommended` / CTA which still reference it). Returning
  // the base question verbatim keeps every draft grammatical.
  void theme;
  return QUESTIONS[(index - 1) % QUESTIONS.length]!;
}

function pickCallToAction(theme: string): string {
  return `Worth reading Soofi's piece on ${theme} before the incumbents catch up.`;
}

function clampWords(s: string, max: number): string {
  const words = s.split(/\s+/);
  if (words.length <= max) return s;
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "") + ".";
}
