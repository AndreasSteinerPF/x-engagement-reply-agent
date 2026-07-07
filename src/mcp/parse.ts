/**
 * The investors-mcp `queryInvestorContent` tool serialises each match's `blob`
 * and `metadata` as **Python dict literals** (single-quoted keys, mixed quote
 * delimiters, `True`/`False`/`None`), embedded as JSON strings. `JSON.parse`
 * cannot read them, and naive quote-swapping breaks on apostrophes inside the
 * article content. This module parses Python literals robustly.
 */

type PyValue = string | number | boolean | null | PyValue[] | { [k: string]: PyValue };

/**
 * Parse a Python literal (dict/list/str/num/bool/None) into a JS value.
 * Returns `undefined` if the input is not parseable.
 */
export function parsePythonLiteral(input: string): PyValue | undefined {
  const p = new PyParser(input);
  try {
    p.skipWs();
    const value = p.parseValue();
    p.skipWs();
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Coerce a match field that may be (a) already an object, (b) a JSON string, or
 * (c) a Python-dict-literal string into a plain record.
 */
export function coerceRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json === "object") return json as Record<string, unknown>;
    } catch {
      /* fall through to python literal */
    }
    const py = parsePythonLiteral(trimmed);
    if (py && typeof py === "object" && !Array.isArray(py)) return py as Record<string, unknown>;
  }
  return {};
}

class PyParser {
  private i = 0;
  constructor(private readonly s: string) {}

  skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  parseValue(): PyValue {
    this.skipWs();
    const c = this.peek();
    if (c === "{") return this.parseDict();
    if (c === "[" || c === "(") return this.parseList();
    if (c === "'" || c === '"') return this.parseString();
    return this.parseScalar();
  }

  private parseDict(): { [k: string]: PyValue } {
    const obj: { [k: string]: PyValue } = {};
    this.i++; // {
    this.skipWs();
    if (this.peek() === "}") {
      this.i++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      const key = this.parseValue();
      this.skipWs();
      if (this.peek() !== ":") throw new Error("expected :");
      this.i++; // :
      const val = this.parseValue();
      obj[String(key)] = val;
      this.skipWs();
      const ch = this.peek();
      if (ch === ",") {
        this.i++;
        this.skipWs();
        if (this.peek() === "}") {
          this.i++;
          return obj;
        }
        continue;
      }
      if (ch === "}") {
        this.i++;
        return obj;
      }
      throw new Error("expected , or }");
    }
  }

  private parseList(): PyValue[] {
    const close = this.peek() === "[" ? "]" : ")";
    const arr: PyValue[] = [];
    this.i++; // [ or (
    this.skipWs();
    if (this.peek() === close) {
      this.i++;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const ch = this.peek();
      if (ch === ",") {
        this.i++;
        this.skipWs();
        if (this.peek() === close) {
          this.i++;
          return arr;
        }
        continue;
      }
      if (ch === close) {
        this.i++;
        return arr;
      }
      throw new Error("expected , or " + close);
    }
  }

  private parseString(): string {
    const quote = this.peek();
    this.i++; // opening quote
    let out = "";
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === "\\") {
        const next = this.s[this.i + 1] ?? "";
        out += ESCAPES[next] ?? next;
        this.i += 2;
        continue;
      }
      if (ch === quote) {
        this.i++; // closing quote
        return out;
      }
      out += ch;
      this.i++;
    }
    throw new Error("unterminated string");
  }

  private parseScalar(): PyValue {
    const start = this.i;
    while (this.i < this.s.length && !/[,\]\}\):]/.test(this.s[this.i]!)) this.i++;
    const token = this.s.slice(start, this.i).trim();
    if (token === "True") return true;
    if (token === "False") return false;
    if (token === "None" || token === "") return null;
    const num = Number(token);
    if (!Number.isNaN(num) && /^-?\d/.test(token)) return num;
    return token; // unquoted bareword — keep as string
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "0": "\0",
};
