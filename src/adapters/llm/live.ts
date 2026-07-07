import type {
  ReplyGenerationInput,
  ReplyGenerationOutput,
  ReplyGenerator,
  SuggestedResponse,
} from "../../ports.js";

const CHAR_LIMIT = 280;

/**
 * Live LLM reply generator. Activates when `modelId` names a provider the
 * environment has a key for (`openai/*` -> OPENAI_API_KEY, `anthropic/*` ->
 * ANTHROPIC_API_KEY). Mirrors the reference draft call: a constant system prompt,
 * a structured user prompt carrying the matched-article context and every reply
 * prompt slot, temperature 0.2, and a JSON-shaped response.
 *
 * No provider key was supplied for this milestone, so this path is shipped but
 * not exercised in the demo; the agent falls back to the deterministic generator.
 */
export class LlmReplyGenerator implements ReplyGenerator {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: { provider: "openai" | "anthropic"; model: string; apiKey: string }) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async generate(input: ReplyGenerationInput): Promise<ReplyGenerationOutput> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const userPrompt = buildUserPrompt(input);

    let parsed: { whyRecommended: string; responses: Array<{ promptIndex: number; text: string }> };
    let ok = true;
    let error: string | undefined;
    try {
      const raw =
        this.provider === "openai"
          ? await this.callOpenAI(input.systemPrompt, userPrompt)
          : await this.callAnthropic(input.systemPrompt, userPrompt);
      parsed = extractJson(raw);
    } catch (err) {
      ok = false;
      error = (err as Error).message;
      parsed = { whyRecommended: "", responses: [] };
    }

    const byIndex = new Map(parsed.responses.map((r) => [r.promptIndex, r.text]));
    const responses: SuggestedResponse[] = input.prompts.map((p) => {
      const text = enforce(byIndex.get(p.index) ?? `Draft unavailable for ${p.label}.`, p.requireQuestion);
      return { promptIndex: p.index, promptLabel: p.label, prompt: p.text, text };
    });

    const finishedAt = new Date().toISOString();
    return {
      whyRecommended: parsed.whyRecommended || "Matched on shared theme with the Soofi article.",
      responses,
      trace: {
        provider: this.provider,
        model: this.model,
        startedAt,
        finishedAt,
        durationMs: Math.round(performance.now() - start),
        promptCount: input.prompts.length,
        inputChars: input.systemPrompt.length + userPrompt.length,
        outputChars: responses.reduce((n, r) => n + r.text.length, 0),
        ok,
        error,
      },
    };
  }

  private async callOpenAI(system: string, user: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  private async callAnthropic(system: string, user: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 900,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    return json.content?.map((c) => c.text ?? "").join("") ?? "";
  }
}

function buildUserPrompt(input: ReplyGenerationInput): string {
  const prompts = input.prompts
    .map(
      (p) =>
        `- promptIndex ${p.index} ("${p.label}"): ${p.text}${p.requireQuestion ? " (end with a thought-provoking question)" : " (end with a call to action, NOT a question)"}`,
    )
    .join("\n");
  return [
    "Draft one X reply per prompt below. Each reply must:",
    ...input.responseConstraints.map((c) => `- ${c}`),
    "- Quote a short phrase from the Soofi article context.",
    "",
    `TARGET POST by @${input.post.handle}:\n${input.post.text}`,
    "",
    `MATCHED SOOFI ARTICLE: ${input.article.title}`,
    `Similarity: raw=${input.article.rawScore.toFixed(4)} score=${input.article.score100}`,
    `ARTICLE CONTEXT:\n${input.article.contextExcerpt}`,
    input.article.supportingParagraphs.length
      ? `SUPPORTING PASSAGES:\n${input.article.supportingParagraphs.map((p) => `- ${p}`).join("\n")}`
      : "",
    "",
    "PROMPTS:",
    prompts,
    "",
    'Respond with JSON: {"whyRecommended": "<=35 words", "responses": [{"promptIndex": <n>, "text": "<=280 chars"}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Extract the first JSON object from a model response, tolerating prose/fences. */
export function extractJson(raw: string): { whyRecommended: string; responses: Array<{ promptIndex: number; text: string }> } {
  const fenced = raw.replace(/```json\s*|\s*```/g, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model response");
  const obj = JSON.parse(fenced.slice(start, end + 1)) as {
    whyRecommended?: string;
    responses?: Array<{ promptIndex?: number; text?: string }>;
  };
  return {
    whyRecommended: String(obj.whyRecommended ?? ""),
    responses: (obj.responses ?? [])
      .filter((r) => typeof r.promptIndex === "number" && typeof r.text === "string")
      .map((r) => ({ promptIndex: r.promptIndex!, text: r.text! })),
  };
}

function enforce(text: string, requireQuestion: boolean): string {
  let out = text.trim();
  if (requireQuestion && !/[?]\s*$/.test(out)) out = `${out.replace(/[.!]\s*$/, "")} What changes if we get this right?`;
  if (out.length > CHAR_LIMIT) out = out.slice(0, CHAR_LIMIT - 1).trimEnd() + "…";
  return out;
}
