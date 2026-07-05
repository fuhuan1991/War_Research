import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted — define stubs inside them and expose via vi.hoisted
const { mockSearch, mockInvoke } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@tavily/core", () => ({
  tavily: () => ({ search: mockSearch }),
}));

vi.mock("../../src/model.js", () => ({
  miniModel: { invoke: mockInvoke },
}));

vi.mock("../../src/config.js", () => ({
  TAVILY_MAX_RESULTS: 4,
}));

import { executeTavilySearch } from "../../src/tools/tavilySearch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTavilyResult(overrides: Partial<{
  title: string;
  url: string;
  content: string;
  rawContent: string;
}> = {}) {
  return {
    title: "Default Title",
    url: "https://example.com/default",
    content: "Default snippet content.",
    rawContent: undefined,
    score: 0.9,
    publishedDate: undefined,
    favicon: undefined,
    ...overrides,
  };
}

function makeModelResponse(summary: string, key_excerpts: string) {
  return { content: JSON.stringify({ summary, key_excerpts }) };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// executeTavilySearch — Tavily API failure
// ---------------------------------------------------------------------------

describe("executeTavilySearch — Tavily API failure", () => {
  it("returns a 'Search failed' message when the Tavily client throws", async () => {
    mockSearch.mockRejectedValueOnce(new Error("network timeout"));

    const result = await executeTavilySearch("some query");

    expect(result).toBe(
      "Search failed: network timeout. Please try a different query."
    );
  });
});

// ---------------------------------------------------------------------------
// executeTavilySearch — empty results
// ---------------------------------------------------------------------------

describe("executeTavilySearch — empty results", () => {
  it("returns the 'no results' message when Tavily returns an empty array", async () => {
    mockSearch.mockResolvedValueOnce({ query: "test", results: [] });

    const result = await executeTavilySearch("test");

    expect(result).toBe(
      "No valid search results found. Please try different search queries or use a different search API."
    );
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("keeps only the first result when two share the same URL", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "tanks",
      results: [
        makeTavilyResult({ url: "https://example.com/a", title: "First",  content: "content A" }),
        makeTavilyResult({ url: "https://example.com/a", title: "Second", content: "content B" }),
      ],
    });

    const result = await executeTavilySearch("tanks");

    // Only one SOURCE block should appear
    expect((result.match(/--- SOURCE \d+:/g) ?? []).length).toBe(1);
    expect(result).toContain("First");
    expect(result).not.toContain("Second");
  });

  it("keeps all results when every URL is unique", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "tanks",
      results: [
        makeTavilyResult({ url: "https://example.com/1", title: "Alpha" }),
        makeTavilyResult({ url: "https://example.com/2", title: "Beta" }),
        makeTavilyResult({ url: "https://example.com/3", title: "Gamma" }),
      ],
    });

    const result = await executeTavilySearch("tanks");

    expect((result.match(/--- SOURCE \d+:/g) ?? []).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// summarizeWebpage — success path
// ---------------------------------------------------------------------------

describe("summarizeWebpage — success path", () => {
  it("wraps model output in <summary> and <key_excerpts> tags", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "battle",
      results: [
        makeTavilyResult({
          url: "https://example.com/battle",
          title: "Battle Details",
          rawContent: "Long raw content about the battle.",
        }),
      ],
    });
    mockInvoke.mockResolvedValueOnce(
      makeModelResponse("A concise summary.", "Excerpt one. Excerpt two.")
    );

    const result = await executeTavilySearch("battle");

    expect(result).toContain("<summary>\nA concise summary.\n</summary>");
    expect(result).toContain("<key_excerpts>\nExcerpt one. Excerpt two.\n</key_excerpts>");
  });
});

// ---------------------------------------------------------------------------
// summarizeWebpage — fallback paths
// ---------------------------------------------------------------------------

describe("summarizeWebpage — fallback paths", () => {
  it("falls back to truncated rawContent when the model call throws", async () => {
    const longRaw = "x".repeat(1500);
    mockSearch.mockResolvedValueOnce({
      query: "fallback test",
      results: [
        makeTavilyResult({ url: "https://example.com/err", rawContent: longRaw }),
      ],
    });
    mockInvoke.mockRejectedValueOnce(new Error("model error"));

    const result = await executeTavilySearch("fallback test");

    expect(result).toContain("x".repeat(1000) + "...");
  });

  it("falls back to truncated rawContent when the model returns invalid JSON", async () => {
    const longRaw = "y".repeat(1500);
    mockSearch.mockResolvedValueOnce({
      query: "bad json",
      results: [
        makeTavilyResult({ url: "https://example.com/badjson", rawContent: longRaw }),
      ],
    });
    mockInvoke.mockResolvedValueOnce({ content: "not valid json" });

    const result = await executeTavilySearch("bad json");

    expect(result).toContain("y".repeat(1000) + "...");
  });

  it("does not append ellipsis when rawContent is shorter than 1000 chars", async () => {
    const shortRaw = "short content";
    mockSearch.mockResolvedValueOnce({
      query: "short",
      results: [
        makeTavilyResult({ url: "https://example.com/short", rawContent: shortRaw }),
      ],
    });
    mockInvoke.mockRejectedValueOnce(new Error("model error"));

    const result = await executeTavilySearch("short");

    expect(result).toContain("short content");
    expect(result).not.toContain("...");
  });

  it("uses snippet content directly when rawContent is absent", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "no raw",
      results: [
        makeTavilyResult({
          url: "https://example.com/noraw",
          content: "Just the snippet.",
          rawContent: undefined,
        }),
      ],
    });

    const result = await executeTavilySearch("no raw");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toContain("Just the snippet.");
  });
});

// ---------------------------------------------------------------------------
// formatOutput — structure
// ---------------------------------------------------------------------------

describe("formatOutput — structure", () => {
  it("includes SOURCE headers, URLs, and SUMMARY sections for each result", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "ww2",
      results: [
        makeTavilyResult({ url: "https://example.com/p1", title: "Page One", content: "Content one." }),
        makeTavilyResult({ url: "https://example.com/p2", title: "Page Two", content: "Content two." }),
      ],
    });

    const result = await executeTavilySearch("ww2");

    expect(result).toContain("--- SOURCE 1: Page One ---");
    expect(result).toContain("URL: https://example.com/p1");
    expect(result).toContain("--- SOURCE 2: Page Two ---");
    expect(result).toContain("URL: https://example.com/p2");
    expect(result).toContain("SUMMARY:");
  });
});
