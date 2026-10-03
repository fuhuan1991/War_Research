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
import { PREFERRED_DOMAINS } from "../../src/tools/preferredDomains.js";
import { DENIED_DOMAINS } from "../../src/tools/deniedDomains.js";

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

// ---------------------------------------------------------------------------
// formatOutput — provenance signals
//
// DOMAIN and RELEVANCE exist so researcherAssessmentPrompt's <Source Preferences> block has
// something to weigh. Before this, the prompt asked the model to judge source quality while
// executeTavilySearch discarded the only quality signal Tavily returns.
// ---------------------------------------------------------------------------

describe("formatOutput — provenance signals", () => {
  it("emits DOMAIN and RELEVANCE for each source", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "kursk",
      results: [
        makeTavilyResult({ url: "https://www.tankmuseum.org/article/x", title: "Tank" , score: 0.84 }),
      ],
    });

    const result = await executeTavilySearch("kursk");

    // "www." is stripped so the same site reads identically however Tavily returns it.
    expect(result).toContain("DOMAIN: tankmuseum.org");
    expect(result).toContain("RELEVANCE: 0.84");
  });

  it("prints RELEVANCE as n/a rather than crashing when Tavily omits the score", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "kursk",
      results: [makeTavilyResult({ url: "https://example.com/p", score: undefined })],
    });

    const result = await executeTavilySearch("kursk");

    expect(result).toContain("RELEVANCE: n/a");
    expect(result).toContain("DOMAIN: example.com");
  });

  it("falls back to 'unknown' for a malformed URL instead of throwing", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "kursk",
      results: [makeTavilyResult({ url: "not-a-url" })],
    });

    const result = await executeTavilySearch("kursk");

    expect(result).toContain("DOMAIN: unknown");
  });
});

// ---------------------------------------------------------------------------
// domain policy — what gets sent to Tavily
// ---------------------------------------------------------------------------

describe("domain policy", () => {
  it("steers with includeDomains in soft 'prefer' mode and hard-excludes the denylist", async () => {
    mockSearch.mockResolvedValueOnce({ query: "q", results: [] });

    await executeTavilySearch("q");

    const [, options] = mockSearch.mock.calls[0];
    expect(options.includeDomains).toEqual(PREFERRED_DOMAINS);
    expect(options.excludeDomains).toEqual(DENIED_DOMAINS);
    // "restrict" would make the prefer list a filter. Measured against the live API, a 1453
    // query restricted to the whole list returns only Wikipedia and Britannica — so this
    // assertion is the guard against a one-word change that silently starves sparse topics.
    expect(options.includeDomainsMode).toBe("prefer");
  });
});

// ---------------------------------------------------------------------------
// list hygiene
//
// The prefer list was assembled by merging two independently-curated lists, which is exactly
// how duplicates, stray "www." prefixes and full URLs creep in. These are static assertions
// over data, so they cost nothing to run.
// ---------------------------------------------------------------------------

describe("domain list hygiene", () => {
  const lists: [string, string[]][] = [
    ["PREFERRED_DOMAINS", PREFERRED_DOMAINS],
    ["DENIED_DOMAINS", DENIED_DOMAINS],
  ];

  for (const [name, list] of lists) {
    it(`${name} is non-empty and free of duplicates`, () => {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    });

    it(`${name} holds bare lowercase hostnames — no scheme, path, "www." or whitespace`, () => {
      for (const domain of list) {
        expect(domain).toBe(domain.toLowerCase().trim());
        expect(domain).not.toMatch(/^https?:\/\//);
        expect(domain).not.toMatch(/^www\./);
        expect(domain).not.toContain("/");
        expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      }
    });
  }

  it("keeps the two lists disjoint, so nothing is both preferred and denied", () => {
    const denied = new Set(DENIED_DOMAINS);
    expect(PREFERRED_DOMAINS.filter((d) => denied.has(d))).toEqual([]);
  });

  it("includes en.wikipedia.org, which sparse topics depend on", () => {
    // Measured: restricting a 1453 query to the whole prefer list returns Wikipedia and
    // Britannica alone. Dropping it would hand those topics to forums and video pages.
    expect(PREFERRED_DOMAINS).toContain("en.wikipedia.org");
  });
});

// ---------------------------------------------------------------------------
// fiction exclusion
// ---------------------------------------------------------------------------

describe("fiction exclusion", () => {
  // These are not merely low-authority — they are invented history on the same topics the
  // agent researches, and a real run cited one as *confirming* a Venetian naval judgement
  // while its DOMAIN and a RELEVANCE of 0.55 were visible in the prompt. Prompt guidance did
  // not catch it, so the exclusion has to be mechanical and has to stay.
  it.each(["alternatehistory.com", "thisdayinalternatehistory.blogspot.com", "fandom.com"])(
    "denies %s",
    (domain) => {
      expect(DENIED_DOMAINS).toContain(domain);
    },
  );
});
