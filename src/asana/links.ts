function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Ported near-verbatim from investors-mcp's buildXReplyIntentUrl.
 * Deliberately keeps the `twitter.com` host (not `x.com`) -- it's the
 * long-standing, known-working compose-intent URL and matches the
 * reference exactly; x.com redirects to it anyway.
 */
export function buildXReplyIntentUrl(params: { statusId: string; text: string }): string {
  const statusId = normalizeWhitespace(params.statusId || "");
  const text = params.text.replace(/\r/g, "").trim();
  if (!statusId || !text) return "";

  const query = new URLSearchParams({ in_reply_to: statusId, text });
  return `https://twitter.com/intent/tweet?${query.toString()}`;
}
