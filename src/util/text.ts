export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Ported near-verbatim from investors-mcp's truncateToHeader.
 */
export function truncateToHeader(text: string, maxLength = 80): string {
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.5) {
    return `${truncated.slice(0, lastSpace)}...`;
  }
  return `${truncated}...`;
}
