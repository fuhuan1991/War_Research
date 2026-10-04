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

// Mirrors the real values. This mock replaces the whole module, so a constant missing
// here reads as undefined inside tavilySearch.ts — and `slice(0, undefined)` returns the
// entire string, which would turn the raw-content cap into a silent no-op under test.
vi.mock("../../src/config.js", () => ({
  TAVILY_MAX_RESULTS: 4,
  MAX_RAW_CONTENT_CHARS: 200_000,
}));

import { executeTavilySearch } from "../../src/tools/tavilySearch.js";
import { MAX_RAW_CONTENT_CHARS } from "../../src/config.js";
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

// executeTavilySearch requires the caller's set of already-summarised URLs. Most tests here
// exercise a single search in isolation and want a clean slate, so this defaults to an empty
// set; the run-level dedupe tests pass their own set in and inspect it afterwards.
function search(query: string, seen: Set<string> = new Set()) {
  return executeTavilySearch(query, seen);
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

    const result = await search("some query");

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

    const result = await search("test");

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

    const result = await search("tanks");

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

    const result = await search("tanks");

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

    const result = await search("battle");

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

    const result = await search("fallback test");

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

    const result = await search("bad json");

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

    const result = await search("short");

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

    const result = await search("no raw");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toContain("Just the snippet.");
  });
});

// ---------------------------------------------------------------------------
// summarizeWebpage — oversized pages
//
// Tavily returns the full extracted text of a result, and a result can be a whole book.
// These pin the ceiling that stops that, and the marker that admits to it.
// ---------------------------------------------------------------------------

describe("summarizeWebpage — oversized pages", () => {
  // Head and tail markers rather than a length assertion: this states the semantics the
  // cap is for — the start of the page survives, the overflow does not.
  const HEAD = "HEAD_OF_PAGE";
  const TAIL = "TAIL_PAST_THE_CAP";
  const oversized = HEAD + "a".repeat(MAX_RAW_CONTENT_CHARS) + TAIL;

  function searchReturning(rawContent: string) {
    mockSearch.mockResolvedValueOnce({
      query: "oversized",
      results: [makeTavilyResult({ url: "https://example.com/book.pdf", rawContent })],
    });
    mockInvoke.mockResolvedValueOnce(makeModelResponse("A summary.", "An excerpt."));
  }

  it("cuts page text at MAX_RAW_CONTENT_CHARS before it reaches the model", async () => {
    searchReturning(oversized);

    await search("oversized");

    const prompt = mockInvoke.mock.calls[0][0][0].content as string;
    expect(prompt).toContain(HEAD);
    expect(prompt).not.toContain(TAIL);
  });

  it("hands the model exactly MAX_RAW_CONTENT_CHARS of page text", async () => {
    searchReturning(oversized);
    await search("oversized");
    const cappedPrompt = (mockInvoke.mock.calls[0][0][0].content as string).length;

    vi.clearAllMocks();

    // Same page one char under the ceiling: the prompts must differ by exactly that char,
    // which pins the cut point without hardcoding the prompt template's own length.
    searchReturning("b".repeat(MAX_RAW_CONTENT_CHARS - 1));
    await search("under");
    const underPrompt = (mockInvoke.mock.calls[0][0][0].content as string).length;

    expect(cappedPrompt - underPrompt).toBe(1);
  });

  it("flags the truncation in the SOURCE block so the researcher can discount it", async () => {
    searchReturning(oversized);

    const result = await search("oversized");

    expect(result).toContain(`<note>Source page exceeded ${MAX_RAW_CONTENT_CHARS} characters`);
    expect(result).toContain("<summary>\nA summary.\n</summary>");
  });

  it("leaves a page under the ceiling untouched and adds no note", async () => {
    const ordinary = "c".repeat(MAX_RAW_CONTENT_CHARS - 1);
    searchReturning(ordinary);

    const result = await search("ordinary");

    const prompt = mockInvoke.mock.calls[0][0][0].content as string;
    expect(prompt).toContain(ordinary);
    expect(result).not.toContain("<note>");
  });
});

// ---------------------------------------------------------------------------
// Run-level URL dedupe
//
// A page is summarised once per researcher run, not once per search that happens to return
// it. Measured before this existed: across six traced runs, 28 of 84 summarisation calls were
// for a page already summarised earlier in the same run — in one run the same Wikipedia
// article four times, and in one turn the same two pages twice between that turn's own two
// parallel searches.
// ---------------------------------------------------------------------------

describe("run-level URL dedupe", () => {
  it("summarises a fresh page and records it in the caller's set", async () => {
    const seen = new Set<string>();
    mockSearch.mockResolvedValueOnce({
      query: "austerlitz",
      results: [makeTavilyResult({ url: "https://example.com/a", rawContent: "page text" })],
    });
    mockInvoke.mockResolvedValueOnce(makeModelResponse("A summary", "An excerpt"));

    const result = await search("austerlitz", seen);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(seen.has("https://example.com/a")).toBe(true);
    expect(result).toContain("A summary");
  });

  it("does not summarise a page already in the set", async () => {
    const seen = new Set(["https://example.com/a"]);
    mockSearch.mockResolvedValueOnce({
      query: "austerlitz",
      results: [makeTavilyResult({ url: "https://example.com/a", rawContent: "page text" })],
    });

    const result = await search("austerlitz", seen);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toContain("ALREADY RETRIEVED");
  });

  it("names the withheld page, so the researcher can find it rather than think it is missing", async () => {
    const seen = new Set(["https://example.com/held"]);
    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [
        makeTavilyResult({ title: "Held Page", url: "https://example.com/held", rawContent: "text" }),
        makeTavilyResult({ title: "New Page", url: "https://example.com/new", rawContent: "text" }),
      ],
    });
    mockInvoke.mockResolvedValueOnce(makeModelResponse("New summary", "excerpt"));

    const result = await search("q", seen);

    expect(result).toContain("Held Page");
    expect(result).toContain("https://example.com/held");
    expect(result).toContain("--- SOURCE 1: New Page ---");
  });

  it("summarises a shared page only once across two searches sharing one set", async () => {
    const seen = new Set<string>();
    const shared = makeTavilyResult({ url: "https://example.com/shared", rawContent: "text" });

    mockSearch.mockResolvedValueOnce({ query: "first", results: [shared] });
    mockSearch.mockResolvedValueOnce({ query: "second", results: [shared] });
    mockInvoke.mockResolvedValueOnce(makeModelResponse("Shared summary", "excerpt"));

    const first = await search("first", seen);
    const second = await search("second", seen);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(first).toContain("Shared summary");
    expect(second).toContain("ALREADY RETRIEVED");
    expect(second).not.toContain("Shared summary");
  });

  it("summarises a shared page once when two searches run concurrently on one set", async () => {
    // The intra-turn case, and the one that depends on a URL being claimed synchronously —
    // before the first await in processResults. If the claim moved after the summarisation,
    // both concurrent calls would pass the has() check and summarise the same page. The
    // sequential test above cannot catch that, because its first call has already finished.
    const seen = new Set<string>();
    const shared = makeTavilyResult({ url: "https://example.com/both", rawContent: "text" });

    mockSearch.mockResolvedValue({ query: "q", results: [shared] });
    mockInvoke.mockResolvedValue(makeModelResponse("Shared summary", "excerpt"));

    const [a, b] = await Promise.all([search("first", seen), search("second", seen)]);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // Which call wins depends on which Tavily response settles first, so assert that exactly
    // one got the content and the other got the withheld notice — not which.
    const summarised = [a, b].filter((r) => r.includes("Shared summary"));
    const withheld = [a, b].filter((r) => r.includes("ALREADY RETRIEVED"));
    expect(summarised).toHaveLength(1);
    expect(withheld).toHaveLength(1);
  });

  it("reports an all-duplicate result set as such, not as 'no results found'", async () => {
    const seen = new Set(["https://example.com/a", "https://example.com/b"]);
    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [
        makeTavilyResult({ url: "https://example.com/a", rawContent: "text" }),
        makeTavilyResult({ url: "https://example.com/b", rawContent: "text" }),
      ],
    });

    const result = await search("q", seen);

    // "No valid search results found. Please try different search queries" would be false
    // here — results came back, they were already held — and it steers the assessment toward
    // rewording the query, which is the behaviour this whole mechanism exists to stop.
    expect(result).not.toContain("No valid search results found");
    expect(result).toContain("no new sources");
    expect(result).toContain("2 result(s)");
  });

  it("still reports 'no results found' when Tavily genuinely returned nothing", async () => {
    mockSearch.mockResolvedValueOnce({ query: "q", results: [] });

    const result = await search("q", new Set(["https://example.com/a"]));

    expect(result).toContain("No valid search results found");
  });

  it("leaves a page out of the set when its summarisation failed, so a later search may retry it", async () => {
    const seen = new Set<string>();
    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [makeTavilyResult({ url: "https://example.com/flaky", rawContent: "x".repeat(50) })],
    });
    mockInvoke.mockRejectedValueOnce(new Error("model error"));

    await search("q", seen);

    // Recording a failed page as seen would lock its 1000-char fragment in for the whole run.
    expect(seen.has("https://example.com/flaky")).toBe(false);
  });

  it("records a page with no raw content, which needs no model call", async () => {
    const seen = new Set<string>();
    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [makeTavilyResult({ url: "https://example.com/snippet", rawContent: undefined })],
    });

    await search("q", seen);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(seen.has("https://example.com/snippet")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failed summarisation is visible
//
// The fallback is raw page text cut mid-sentence. Printed under SUMMARY: with nothing marking
// it, it reads as a summary of the whole page — observed on a europeana.eu page that reached
// the researcher as 1,252 characters ending mid-word, twice, with nothing logged.
// ---------------------------------------------------------------------------

describe("failed summarisation is marked", () => {
  it("labels the fragment as a failure rather than passing it off as a summary", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [makeTavilyResult({ url: "https://example.com/err", rawContent: "z".repeat(1500) })],
    });
    mockInvoke.mockRejectedValueOnce(new Error("model error"));

    const result = await search("q");

    expect(result).toContain("Summarisation of this page failed");
    expect(result).toContain("not a summary");
    expect(result).not.toContain("<summary>");
  });

  it("logs the reason instead of discarding it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockSearch.mockResolvedValueOnce({
      query: "q",
      results: [makeTavilyResult({ url: "https://example.com/err", rawContent: "text" })],
    });
    mockInvoke.mockRejectedValueOnce(new Error("context length exceeded"));

    await search("q");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("context length exceeded"));
    warn.mockRestore();
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

    const result = await search("ww2");

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

    const result = await search("kursk");

    // "www." is stripped so the same site reads identically however Tavily returns it.
    expect(result).toContain("DOMAIN: tankmuseum.org");
    expect(result).toContain("RELEVANCE: 0.84");
  });

  it("prints RELEVANCE as n/a rather than crashing when Tavily omits the score", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "kursk",
      results: [makeTavilyResult({ url: "https://example.com/p", score: undefined })],
    });

    const result = await search("kursk");

    expect(result).toContain("RELEVANCE: n/a");
    expect(result).toContain("DOMAIN: example.com");
  });

  it("falls back to 'unknown' for a malformed URL instead of throwing", async () => {
    mockSearch.mockResolvedValueOnce({
      query: "kursk",
      results: [makeTavilyResult({ url: "not-a-url" })],
    });

    const result = await search("kursk");

    expect(result).toContain("DOMAIN: unknown");
  });
});

// ---------------------------------------------------------------------------
// domain policy — what gets sent to Tavily
// ---------------------------------------------------------------------------

describe("domain policy", () => {
  it("steers with includeDomains in soft 'prefer' mode and hard-excludes the denylist", async () => {
    mockSearch.mockResolvedValueOnce({ query: "q", results: [] });

    await search("q");

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
