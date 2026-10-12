import { describe, it, expect } from "vitest";
import {
  countSources,
  countWords,
  extractOutline,
  renderHtml,
  reportBaseName,
  slugify,
  stripCodeFence,
  stripInline,
} from "../../src/reportOutput.js";

// =============================================================================
// src/reportOutput.ts is pure, so all of this runs under `npm test` with no API
// calls. Two groups matter more than the rest: the escaping/URL tests, because
// a report body is assembled from Tavily-scraped page text, and the `$&` group,
// which is the same hazard tests/unit/fillTemplate.test.ts pins down one layer
// up — this module does its own replacing and had to earn the same guarantee.
// =============================================================================

// A trimmed stand-in for a real report: the shapes reports/*.md actually use.
const REPORT = `# Napoleon at Austerlitz: Command and Deception

## Introduction

The battle of 2 December 1805 is widely read as Napoleon's tactical masterpiece
[Battle of Austerlitz - Wikipedia](https://en.wikipedia.org/wiki/Battle_of_Austerlitz).

## Tactical Decisions in the Morning Fog

### The Battlefield

- The Pratzen Heights dominated the field [napoleon.org](https://www.napoleon.org/austerlitz).
- Napoleon abandoned the high ground [Wikipedia](https://en.wikipedia.org/wiki/Battle_of_Austerlitz).
    - **Overconfidence:** the Allies underestimated French strength.

## Conclusion

A decisive victory.
`;

describe("extractOutline", () => {
  it("reads the title and the ## sections, ignoring ###", () => {
    expect(extractOutline(REPORT)).toEqual({
      title: "Napoleon at Austerlitz: Command and Deception",
      sections: ["Introduction", "Tactical Decisions in the Morning Fog", "Conclusion"],
    });
  });

  it("returns an empty title for a report with no # heading", () => {
    expect(extractOutline("## Only a section\n\nbody")).toEqual({
      title: "",
      sections: ["Only a section"],
    });
  });

  it("keeps the first # when a report somehow has two", () => {
    expect(extractOutline("# First\n# Second").title).toBe("First");
  });

  it("strips inline markup out of headings", () => {
    // Headings are printed to a terminal as prose, so the syntax has to go.
    expect(extractOutline("## The **Fog** of [War](https://x.test/w)").sections).toEqual([
      "The Fog of War",
    ]);
  });

  it("does not mistake a #hashtag for a heading", () => {
    expect(extractOutline("#notaheading\n\n## Real").sections).toEqual(["Real"]);
  });
});

describe("stripInline", () => {
  it("leaves a bare asterisk and underscore alone", () => {
    expect(stripInline("2 * 3 and snake_case_name")).toBe("2 * 3 and snake_case_name");
  });
});

describe("countSources", () => {
  it("counts each cited URL once, however often it is cited", () => {
    // The Wikipedia URL appears three times in REPORT; napoleon.org once.
    expect(countSources(REPORT)).toBe(2);
  });

  it("does not count images as sources", () => {
    expect(countSources("![a map](https://x.test/map.png) and [a source](https://y.test)")).toBe(1);
  });

  it("is zero for a report with no links", () => {
    expect(countSources("# Title\n\nNo citations at all.")).toBe(0);
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  one two\nthree\t four  ")).toBe(4);
  });

  it("is zero for an empty report rather than one", () => {
    expect(countWords("   \n  ")).toBe(0);
  });
});

describe("stripCodeFence", () => {
  it("unwraps a report the model fenced as markdown", () => {
    expect(stripCodeFence("```markdown\n# Title\n\nBody.\n```")).toBe("# Title\n\nBody.");
  });

  it("unwraps an unlabelled fence too", () => {
    expect(stripCodeFence("```\n# Title\n```")).toBe("# Title");
  });

  it("leaves a report whose body merely contains a fence alone", () => {
    const report = "# Title\n\n```\nsome code\n```\n\nMore prose.";
    expect(stripCodeFence(report)).toBe(report);
  });

  it("leaves an unterminated fence alone rather than eating the report", () => {
    const report = "```markdown\n# Title\n\nBody with no closing fence.";
    expect(stripCodeFence(report)).toBe(report);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Battle of Austerlitz")).toBe("battle-of-austerlitz");
  });

  it("drops punctuation and collapses runs of it", () => {
    expect(slugify("Napoleon’s Command — Decisions, 1805!")).toBe(
      "napoleons-command-decisions-1805",
    );
  });

  it("keeps a short topic's connectives", () => {
    expect(slugify("Battle of the Bulge")).toBe("battle-of-the-bulge");
  });

  it("folds diacritics to ASCII", () => {
    expect(slugify("Battle of Kôbe & Łódź")).toBe("battle-of-kobe-lodz");
  });

  it("transliterates the letters NFKD cannot decompose", () => {
    // Ł and Ø are distinct letters, not a base plus a combining mark, so
    // normalization leaves them untouched and the ASCII filter would drop them.
    expect(slugify("Ørland and Malört")).toBe("orland-and-malort");
  });

  it("drops connectives from a topic too long to fit whole", () => {
    // The real case: a blind truncation spends the budget on "at the battle of"
    // and loses both Kursk and the date.
    expect(
      slugify("The tank engagement at Prokhorovka during the Battle of Kursk, 12 July 1943."),
    ).toBe("tank-engagement-prokhorovka-battle-kursk-12-july-1943");
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const slug = slugify(
      "the strategic and operational consequences of the winter counteroffensive campaign",
    );
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe("strategic-operational-consequences-winter-counteroffensive");
  });

  it("caps a single very long word at the limit", () => {
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });

  it("returns an empty string when there is nothing to slug", () => {
    // The caller's signal to fall back to a timestamp.
    expect(slugify("—— !!! ——")).toBe("");
  });
});

describe("reportBaseName", () => {
  // Built from LOCAL components, so the expected date holds whatever timezone the
  // suite runs in. The UTC one is only for the timestamp fallback, which stays UTC.
  const local = new Date(2026, 9, 11, 14, 32);
  const utc = new Date("2026-10-11T14:32:05.123Z");

  it("dates the file and names it after the topic", () => {
    expect(reportBaseName({ final_topic: "Battle of Austerlitz" }, local)).toBe(
      "2026-10-11-battle-of-austerlitz",
    );
  });

  it("dates the file in local time rather than UTC", () => {
    // The reported bug: a report written at 19:24 on the 11th from a timezone
    // behind Greenwich was named 2026-10-12, because toISOString had rolled over.
    expect(reportBaseName({ final_topic: "Austerlitz" }, new Date(2026, 9, 11, 23, 59))).toBe(
      "2026-10-11-austerlitz",
    );
  });

  it("falls back to a timestamp with no plan", () => {
    // The fallback stays UTC on purpose — the trailing Z says which zone it is.
    expect(reportBaseName(null, utc)).toBe("2026-10-11T14-32-05-123Z");
  });

  it("falls back to a timestamp when the topic slugs to nothing", () => {
    // Naming a file must never be what loses a report that cost a research run.
    expect(reportBaseName({ final_topic: "???" }, utc)).toBe("2026-10-11T14-32-05-123Z");
  });
});

describe("renderHtml: structure", () => {
  const html = renderHtml(REPORT, "Napoleon at Austerlitz");

  it("produces one self-contained document with no external references", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<(script|link)\b/);
  });

  it("maps headings to their levels", () => {
    expect(html).toContain("<h1>Napoleon at Austerlitz: Command and Deception</h1>");
    expect(html).toContain("<h2>Introduction</h2>");
    expect(html).toContain("<h3>The Battlefield</h3>");
  });

  it("nests a deeper bullet inside its parent item", () => {
    expect(html).toMatch(/<li>Napoleon abandoned[\s\S]*?<ul>[\s\S]*?<\/ul>\s*<\/li>/);
  });

  it("renders citations as new-tab links", () => {
    expect(html).toContain(
      '<a href="https://www.napoleon.org/austerlitz" target="_blank" rel="noopener">napoleon.org</a>',
    );
  });

  it("renders bold, and joins a wrapped paragraph into one <p>", () => {
    expect(html).toContain("<strong>Overconfidence:</strong>");
    expect(html).toContain("The battle of 2 December 1805 is widely read as Napoleon's tactical masterpiece");
  });

  it("reports the counts in the footer", () => {
    expect(html).toContain("2 sources");
  });

  it("renders an ordered list as <ol>", () => {
    expect(renderHtml("1. first\n2. second", "t")).toContain("<ol>\n<li>first</li>");
  });
});

describe("renderHtml: untrusted content", () => {
  // Report bodies carry Tavily-scraped page text, so none of this is theoretical.
  it("escapes markup that arrived in the prose", () => {
    const html = renderHtml("# T\n\nHe wrote <script>alert(1)</script> on the wall.", "t");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes markup that arrived in a heading", () => {
    expect(renderHtml("## <img onerror=x>", "t")).toContain("<h2>&lt;img onerror=x&gt;</h2>");
  });

  it("escapes the document title", () => {
    expect(renderHtml("# T", '"><script>')).toContain("<title>&quot;&gt;&lt;script&gt;</title>");
  });

  it("never emits a link for a javascript: URL", () => {
    const html = renderHtml("[click me](javascript:alert)", "t");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).toContain("click me");
  });

  it("rejects a javascript: URL whatever its casing", () => {
    expect(renderHtml("[x](JaVaScRiPt:alert)", "t")).not.toContain("<a ");
  });

  it("leaves a parenthesised URL as inert text rather than a link", () => {
    // The link pattern will not span the inner parens, so nothing is linkified.
    // The text stays visible, escaped, which is the safe failure.
    const html = renderHtml("[click me](javascript:alert(1))", "t");
    expect(html).not.toContain("<a ");
    expect(html).toContain("click me");
  });

  it("drops a relative URL rather than emitting a broken link", () => {
    const html = renderHtml("[local](/etc/passwd)", "t");
    expect(html).not.toContain("<a ");
    expect(html).toContain("local");
  });

  it("keeps a query string intact and escaped inside the href", () => {
    const html = renderHtml("[q](https://x.test/s?a=1&b=2)", "t");
    expect(html).toContain('href="https://x.test/s?a=1&amp;b=2"');
  });
});

describe("renderHtml: $ patterns are not expanded", () => {
  // Same bug class as fillTemplate's: a replacement STRING expands these, a
  // replacer function does not. Reachable here through scraped page text.
  it("leaves $& in prose alone", () => {
    // Escaped to $&amp; like any other ampersand — what matters is that the
    // surrounding text was not duplicated into the match's place.
    expect(renderHtml("# T\n\ncosts $& rose", "t")).toContain("costs $&amp; rose");
  });

  it("does not let $' splice the rest of the document into a heading", () => {
    const html = renderHtml("## see $' here\n\nTAIL", "t");
    expect(html).toContain("<h2>see $' here</h2>");
    expect(html.match(/TAIL/g)).toHaveLength(1);
  });

  it("leaves $ patterns inside bold and link text alone", () => {
    const html = renderHtml("**$`a$&b** and [$'c](https://x.test)", "t");
    expect(html).toContain("<strong>$`a$&amp;b</strong>");
    expect(html).toContain(">$'c</a>");
  });
});
