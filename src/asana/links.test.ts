import { describe, expect, it } from "vitest";
import { buildXReplyIntentUrl } from "./links";

describe("buildXReplyIntentUrl", () => {
  it("builds a twitter.com compose-intent URL with the status id and text", () => {
    const url = buildXReplyIntentUrl({ statusId: "123", text: "Hello world" });
    expect(url).toBe("https://twitter.com/intent/tweet?in_reply_to=123&text=Hello+world");
  });

  it("url-encodes special characters in the reply text", () => {
    const url = buildXReplyIntentUrl({ statusId: "123", text: "Q: what's next?" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("Q: what's next?");
  });

  it("returns an empty string when statusId is missing", () => {
    expect(buildXReplyIntentUrl({ statusId: "", text: "hello" })).toBe("");
  });

  it("returns an empty string when text is empty after trimming", () => {
    expect(buildXReplyIntentUrl({ statusId: "123", text: "   " })).toBe("");
  });

  it("strips carriage returns before building the URL", () => {
    const url = buildXReplyIntentUrl({ statusId: "123", text: "line one\r\nline two" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("line one\nline two");
  });
});
