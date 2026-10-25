import { describe, it, expect, vi } from "vitest";
import type { HumanMessage } from "@langchain/core/messages";

// illustrate.ts imports the model singletons at module scope for its default `llm`, and
// src/model.ts constructs ChatOpenAI instances that need a key. Every test here injects its
// own model, so the real one is replaced rather than loaded — which is what keeps this file
// runnable with no .env. Same pattern as tests/unit/researchAgent.test.ts.
vi.mock("../../src/model.js", () => ({ miniModel: {} }));

import {
  ImagePickOutput,
  ImageQueryOutput,
  illustrateReport,
  type IllustrateDeps,
  type IllustrateModel,
} from "../../src/images/illustrate.js";
import type { ImageCandidate, ImageSearchFn } from "../../src/images/commonsImages.js";
import { countImages } from "../../src/images/insertImages.js";
import { MAX_IMAGE_QUERIES_PER_REPORT } from "../../src/config.js";

// =============================================================================
// The illustration pass, with both LLM calls and the Commons client injected.
//
// The load-bearing cases are the ones where the picking model misbehaves. It returns
// candidate NUMBERS rather than URLs precisely so that a wrong answer is detectable, and
// these tests pin that every kind of wrong answer is discarded rather than placed.
// =============================================================================

type QueryAnswer = { sections: { index: number; queries: string[] }[] };
type PickAnswer = { sections: { index: number; picks: { candidate: number; alt: string }[] }[] };

/** Records the prompt each call received, so a test can assert what the model was shown. */
const fakeModel = (queries: QueryAnswer, picks: PickAnswer) => {
  const prompts: { call: "query" | "pick"; text: string }[] = [];

  const model = {
    withStructuredOutput: ((schema: unknown) => ({
      invoke: async (messages: HumanMessage[]) => {
        const isQuery = schema === ImageQueryOutput;
        prompts.push({ call: isQuery ? "query" : "pick", text: String(messages[0].content) });
        if (!isQuery && schema !== ImagePickOutput) throw new Error("unexpected schema");
        return isQuery ? queries : picks;
      },
    })) as IllustrateModel["withStructuredOutput"],
  };

  return { model: model as IllustrateModel, prompts };
};

const candidate = (overrides: Partial<ImageCandidate> = {}): ImageCandidate => ({
  id: "File:Gerard.jpg",
  url: "https://thumb.wikimedia.org/960px-Gerard.jpg",
  descriptionUrl: "https://commons.wikimedia.org/wiki/File:Gerard.jpg",
  width: 4000,
  height: 1983,
  title: "Gerard Austerlitz",
  artist: "François Gérard",
  licence: "Public domain",
  ...overrides,
});

const REPORT = [
  "# Austerlitz",
  "",
  "## The Approach March",
  "",
  "Prose about the approach.",
  "",
  "## Sources",
  "",
  "- [A source](https://example.com/a)",
].join("\n");

/** Default deps: everything stubbed, every URL reachable. */
const deps = (
  queries: QueryAnswer,
  picks: PickAnswer,
  search: ImageSearchFn,
  overrides: Partial<IllustrateDeps> = {},
): IllustrateDeps & { prompts: { call: string; text: string }[] } => {
  const { model, prompts } = fakeModel(queries, picks);
  return { llm: model, search, reachable: async () => true, ...overrides, prompts };
};

describe("illustrateReport: the happy path", () => {
  it("places the picked image with the model's alt text and a composed credit", async () => {
    const out = await illustrateReport(
      REPORT,
      ["findings"],
      deps(
        { sections: [{ index: 0, queries: ["Battle of Austerlitz painting"] }] },
        { sections: [{ index: 0, picks: [{ candidate: 1, alt: "Napoleon on the heights" }] }] },
        async () => [candidate()],
      ),
    );

    expect(out).toContain("![Napoleon on the heights](https://thumb.wikimedia.org/960px-Gerard.jpg)");
    expect(out).toContain("*François Gérard — “Gerard Austerlitz”. Public domain via Wikimedia Commons.*");
    // Placed at the end of its own section, not at the end of the document.
    expect(out.indexOf("960px-Gerard.jpg")).toBeLessThan(out.indexOf("## Sources"));
  });

  it("falls back to the file title when the model's alt text is blank", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        { sections: [{ index: 0, picks: [{ candidate: 1, alt: "  " }] }] },
        async () => [candidate()],
      ),
    );
    expect(out).toContain("![Gerard Austerlitz](");
  });

  it("shows the query model the findings and only the illustratable sections", async () => {
    const d = deps(
      { sections: [{ index: 0, queries: ["x"] }] },
      { sections: [{ index: 0, picks: [{ candidate: 1, alt: "a" }] }] },
      async () => [candidate()],
    );
    await illustrateReport(REPORT, ["Austerlitz was fought in fog."], d);

    const queryPrompt = d.prompts.find((p) => p.call === "query")!.text;
    expect(queryPrompt).toContain("[0] The Approach March");
    expect(queryPrompt).toContain("Austerlitz was fought in fog.");
    // `## Sources` is apparatus: never offered, so the model cannot ask for a picture there.
    expect(queryPrompt).not.toContain("Sources");
  });
});

describe("illustrateReport: a misbehaving picking model", () => {
  const twoSections = [
    "## One",
    "",
    "first",
    "",
    "## Two",
    "",
    "second",
  ].join("\n");

  it("discards a candidate number that does not exist", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        { sections: [{ index: 0, picks: [{ candidate: 99, alt: "invented" }] }] },
        async () => [candidate()],
      ),
    );
    expect(out).toBe(REPORT);
  });

  it("discards a candidate that this section was never offered", async () => {
    const out = await illustrateReport(
      twoSections,
      [],
      deps(
        { sections: [{ index: 0, queries: ["a"] }, { index: 1, queries: ["b"] }] },
        // Section 0 is handed candidate 2, which belongs to section 1's search.
        { sections: [{ index: 0, picks: [{ candidate: 2, alt: "wrong" }] }] },
        async (query) => [candidate({ id: `File:${query}.jpg`, title: query })],
      ),
    );
    expect(countImages(out)).toBe(0);
  });

  it("places a repeated image only once", async () => {
    // Both sections' searches return the same Commons file, so it carries one catalogue
    // number — and the model naming it twice must not put the same painting in both.
    const out = await illustrateReport(
      twoSections,
      [],
      deps(
        { sections: [{ index: 0, queries: ["a"] }, { index: 1, queries: ["b"] }] },
        {
          sections: [
            { index: 0, picks: [{ candidate: 1, alt: "once" }] },
            { index: 1, picks: [{ candidate: 1, alt: "twice" }] },
          ],
        },
        async () => [candidate()],
      ),
    );

    expect(countImages(out)).toBe(1);
    expect(out).toContain("![once](");
    expect(out).not.toContain("![twice](");
  });

  it("ignores a section index the report does not have", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        { sections: [{ index: 7, picks: [{ candidate: 1, alt: "nowhere" }] }] },
        async () => [candidate()],
      ),
    );
    expect(out).toBe(REPORT);
  });

  it("ignores queries for a section it was not given", async () => {
    const searched: string[] = [];
    await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["wanted"] }, { index: 1, queries: ["sources"] }] },
        { sections: [] },
        async (query) => {
          searched.push(query);
          return [candidate()];
        },
      ),
    );
    expect(searched).toEqual(["wanted"]);
  });
});

describe("illustrateReport: bounds", () => {
  it("caps the number of Commons queries per report", async () => {
    const searched: string[] = [];
    const many = Array.from({ length: MAX_IMAGE_QUERIES_PER_REPORT + 5 }, (_u, i) => `q${i}`);

    await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: many }] },
        { sections: [] },
        async (query) => {
          searched.push(query);
          return [];
        },
      ),
    );

    expect(searched).toHaveLength(MAX_IMAGE_QUERIES_PER_REPORT);
  });
});

describe("illustrateReport: every failure returns the report unchanged", () => {
  it("does nothing, and spends no model call, when no section can be illustrated", async () => {
    const onlyApparatus = "# Title\n\n## Sources\n\n- a";
    const d = deps({ sections: [] }, { sections: [] }, async () => [candidate()]);

    expect(await illustrateReport(onlyApparatus, [], d)).toBe(onlyApparatus);
    expect(d.prompts).toHaveLength(0);
  });

  it("returns the report when the query model produces no queries", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps({ sections: [{ index: 0, queries: [] }] }, { sections: [] }, async () => [candidate()]),
    );
    expect(out).toBe(REPORT);
  });

  it("returns the report when Commons finds nothing usable", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps({ sections: [{ index: 0, queries: ["x"] }] }, { sections: [] }, async () => []),
    );
    expect(out).toBe(REPORT);
  });

  it("returns the report when the search throws", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        { sections: [] },
        async () => { throw new Error("Commons is down"); },
      ),
    );
    expect(out).toBe(REPORT);
  });

  it("returns the report when the model call throws", async () => {
    const out = await illustrateReport(REPORT, [], {
      llm: {
        withStructuredOutput: (() => ({
          invoke: async () => { throw new Error("rate limited"); },
        })) as IllustrateModel["withStructuredOutput"],
      },
      search: async () => [candidate()],
      reachable: async () => true,
    });
    expect(out).toBe(REPORT);
  });

  it("drops an image whose URL does not serve one", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        { sections: [{ index: 0, picks: [{ candidate: 1, alt: "dead" }] }] },
        async () => [candidate()],
        { reachable: async () => false },
      ),
    );
    expect(out).toBe(REPORT);
  });

  it("keeps the reachable image when a sibling is dead", async () => {
    const out = await illustrateReport(
      REPORT,
      [],
      deps(
        { sections: [{ index: 0, queries: ["x"] }] },
        {
          sections: [
            {
              index: 0,
              picks: [
                { candidate: 1, alt: "dead" },
                { candidate: 2, alt: "alive" },
              ],
            },
          ],
        },
        async () => [
          candidate({ id: "File:Dead.jpg", url: "https://thumb.wikimedia.org/dead.jpg" }),
          candidate({ id: "File:Alive.jpg", url: "https://thumb.wikimedia.org/alive.jpg" }),
        ],
        { reachable: async (url) => url.includes("alive") },
      ),
    );

    expect(countImages(out)).toBe(1);
    expect(out).toContain("![alive](");
  });
});
