import { describe, expect, it, vi } from "vitest";
import { createXClient, XRateLimitError } from "./client";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe("createXClient", () => {
  describe("resolveUserIds", () => {
    it("resolves handles to users, keyed by lowercased username", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: "1", username: "ExampleAuthor", name: "Example Author" }],
        }),
      );

      const client = createXClient({ bearerToken: "test-token", fetchImpl });
      const result = await client.resolveUserIds(["exampleauthor"]);

      expect(result.get("exampleauthor")).toEqual({
        id: "1",
        username: "ExampleAuthor",
        name: "Example Author",
      });
      const [url, requestInit] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("/users/by");
      expect(String(url)).toContain("usernames=exampleauthor");
      expect(requestInit.headers.authorization).toBe("Bearer test-token");
    });

    it("chunks more than 100 handles into multiple requests", async () => {
      const fetchImpl = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const handles = Array.from({ length: 150 }, (_, i) => `user${i}`);
      await client.resolveUserIds(handles);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("returns an empty map for an empty handle list without calling fetch", async () => {
      const fetchImpl = vi.fn();
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const result = await client.resolveUserIds([]);

      expect(result.size).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("fetchRecentPosts", () => {
    it("passes since_id when a cursor is provided", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], includes: {} }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await client.fetchRecentPosts("123", { sinceId: "999", maxResults: 10 });

      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain("since_id=999");
      expect(String(url)).toContain("max_results=10");
      expect(String(url)).toContain("/users/123/tweets");
    });

    it("omits since_id on a first-ever poll", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], includes: {} }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await client.fetchRecentPosts("123");

      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).not.toContain("since_id");
    });

    it("returns posts and includes from the response", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: "1", text: "hello" }],
          includes: { users: [{ id: "1", username: "a", name: "A" }] },
        }),
      );
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const result = await client.fetchRecentPosts("123");

      expect(result.posts).toHaveLength(1);
      expect(result.includes.users).toHaveLength(1);
    });
  });

  describe("fetchPostsByIds", () => {
    it("returns an empty result for an empty id list without calling fetch", async () => {
      const fetchImpl = vi.fn();
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const result = await client.fetchPostsByIds([]);

      expect(result.posts).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fetches posts by id", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ id: "42", text: "original post" }], includes: {} }),
        );
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const result = await client.fetchPostsByIds(["42"]);

      expect(result.posts).toEqual([{ id: "42", text: "original post" }]);
    });
  });

  describe("error handling", () => {
    it("throws XRateLimitError on HTTP 429 with rate-limit headers parsed", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(
          {},
          {
            status: 429,
            headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "1700000000" },
          },
        ),
      );
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await expect(client.fetchRecentPosts("123")).rejects.toThrow(XRateLimitError);
      try {
        await client.fetchRecentPosts("123");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(XRateLimitError);
        expect((error as InstanceType<typeof XRateLimitError>).rateLimit).toEqual({
          remaining: 0,
          resetEpochSeconds: 1700000000,
        });
      }
    });

    it("throws a descriptive error on other non-2xx responses", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, { status: 500 }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await expect(client.fetchRecentPosts("123")).rejects.toThrow(/HTTP 500/);
    });
  });

  describe("response shape validation", () => {
    it("rejects a 2xx response whose tweets don't match the expected shape", async () => {
      // Missing the required `text` field -- a real API returning 200 with
      // a shape that's silently drifted must fail loudly, not pass through.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "1" }] }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await expect(client.fetchRecentPosts("123")).rejects.toThrow(
        /did not match the expected shape/,
      );
    });

    it("treats a body with only unrecognized fields as an empty result, since data/includes are optional", async () => {
      // Documents a real limitation: because `data`/`includes` are optional
      // (a legitimate empty-result response omits them), a 200 response
      // that is actually an unexpected error-shaped object with NO
      // recognized fields at all passes through as "zero posts" rather
      // than throwing. X's API returns non-2xx for real errors (caught
      // above), so this is a low-risk edge case, not a silent-corruption
      // path -- but it's worth being explicit that Zod can't catch it.
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited upstream" }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      const result = await client.fetchRecentPosts("123");
      expect(result.posts).toEqual([]);
    });

    it("rejects resolveUserIds results missing required user fields", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: [{ id: "1", username: "a" }] }));
      const client = createXClient({ bearerToken: "test-token", fetchImpl });

      await expect(client.resolveUserIds(["a"])).rejects.toThrow(
        /did not match the expected shape/,
      );
    });
  });
});
