import { describe, it, expect } from "vitest";

import {
  countImages,
  insertImages,
  renderImageBlock,
  reportSections,
  type ImageRef,
} from "../../src/images/insertImages.js";
import { MAX_IMAGES_PER_SECTION } from "../../src/config.js";

// =============================================================================
// Image placement — the pure half of the illustration feature.
//
// Everything here runs without a network or an API key, which is the whole reason this
// module is separate from src/images/illustrate.ts: deciding WHERE a picture lands is
// where the off-by-one bugs live, and they should be catchable under `npm test`.
// =============================================================================

const ref = (overrides: Partial<ImageRef> = {}): ImageRef => ({
  url: "https://upload.wikimedia.org/a.jpg",
  alt: "A battlefield",
  credit: "Someone. Public domain via Wikimedia Commons.",
  ...overrides,
});

const REPORT = [
  "# The Battle",
  "",
  "## Opening Moves",
  "",
  "Prose about the opening.",
  "",
  "### A subsection",
  "",
  "More prose.",
  "",
  "## Sources",
  "",
  "- [Something](https://example.com/a)",
].join("\n");

describe("reportSections", () => {
  it("finds ## headings and ignores ### subsections", () => {
    expect(reportSections(REPORT).map((section) => section.heading)).toEqual([
      "Opening Moves",
      "Sources",
    ]);
  });

  it("ends a section on its last non-blank line, not on the blank before the next heading", () => {
    const [opening] = reportSections(REPORT);
    expect(REPORT.split("\n")[opening.endLine]).toBe("More prose.");
  });

  it("treats a ### subsection as part of its parent section", () => {
    // The subsection heading must not start a new section, nor end the one it sits in.
    expect(reportSections(REPORT)).toHaveLength(2);
  });

  it("flags apparatus sections as not illustratable", () => {
    const byHeading = new Map(reportSections(REPORT).map((s) => [s.heading, s.illustratable]));
    expect(byHeading.get("Opening Moves")).toBe(true);
    expect(byHeading.get("Sources")).toBe(false);
  });

  it.each(["Sources", "References", "Bibliography", "Further Reading", "**Sources**", "citations"])(
    "treats %s as apparatus",
    (heading) => {
      const [section] = reportSections(`## ${heading}\n\nbody`);
      expect(section.illustratable).toBe(false);
    },
  );

  it("returns nothing for a report with no ## headings", () => {
    expect(reportSections("# Only a title\n\nSome prose.")).toEqual([]);
  });

  it("handles a section with a heading and no body", () => {
    const report = "## Empty\n\n## Next\n\nbody";
    const [empty] = reportSections(report);
    expect(report.split("\n")[empty.endLine]).toBe("## Empty");
  });
});

describe("insertImages", () => {
  it("appends an image and its credit at the end of the section", () => {
    const out = insertImages(REPORT, new Map([[0, [ref()]]]));

    expect(out).toContain(
      [
        "More prose.",
        "",
        "![A battlefield](https://upload.wikimedia.org/a.jpg)",
        "",
        "*Someone. Public domain via Wikimedia Commons.*",
        "",
        "## Sources",
      ].join("\n"),
    );
  });

  it("leaves the report untouched when there is nothing to place", () => {
    expect(insertImages(REPORT, new Map())).toBe(REPORT);
    expect(insertImages(REPORT, new Map([[0, []]]))).toBe(REPORT);
  });

  it("ignores a section index the report does not have", () => {
    expect(insertImages(REPORT, new Map([[9, [ref()]]]))).toBe(REPORT);
  });

  it("enforces MAX_IMAGES_PER_SECTION even when handed more", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_SECTION + 3 }, (_unused, i) =>
      ref({ url: `https://upload.wikimedia.org/${i}.jpg` }),
    );
    expect(countImages(insertImages(REPORT, new Map([[0, many]])))).toBe(MAX_IMAGES_PER_SECTION);
  });

  it("places images in several sections without disturbing each other's line numbers", () => {
    const report = ["## One", "", "first", "", "## Two", "", "second"].join("\n");
    const out = insertImages(
      report,
      new Map([
        [0, [ref({ alt: "one", url: "https://upload.wikimedia.org/1.jpg" })]],
        [1, [ref({ alt: "two", url: "https://upload.wikimedia.org/2.jpg" })]],
      ]),
    );

    expect(out).toContain("first\n\n![one](https://upload.wikimedia.org/1.jpg)");
    expect(out).toContain("second\n\n![two](https://upload.wikimedia.org/2.jpg)");
    expect(countImages(out)).toBe(2);
  });

  it("writes into a Sources section if explicitly told to — the skip lives upstream", () => {
    // reportSections only *flags* apparatus sections; illustrate.ts is what filters them out.
    // Pinned so that moving the decision later is a deliberate change, not a silent one.
    const out = insertImages(REPORT, new Map([[1, [ref()]]]));
    expect(countImages(out)).toBe(1);
  });
});

describe("renderImageBlock: untrusted alt, credit and URL", () => {
  it("strips brackets that would break out of the ![...] label", () => {
    const block = renderImageBlock(ref({ alt: "A [bracketed] shell" }));
    expect(block).toContain("![A bracketed shell]");
  });

  it("strips emphasis characters that would break out of the *credit*", () => {
    const block = renderImageBlock(ref({ credit: "A *starred* _author_" }));
    expect(block).toContain("*A starred author*");
  });

  it("collapses newlines in alt and credit", () => {
    const block = renderImageBlock(ref({ alt: "two\nlines", credit: "also\ntwo" }));
    expect(block).toBe("![two lines](https://upload.wikimedia.org/a.jpg)\n\n*also two*");
  });

  it("percent-encodes parentheses so the link target cannot be closed early", () => {
    // Not the CommonMark <...> form: LINK_PATTERN in reportOutput.ts matches [^()\s]+, so
    // angle brackets would be captured into the URL and new URL() would reject it, silently
    // degrading the image to its alt text in the HTML rendering.
    const block = renderImageBlock(ref({ url: "https://upload.wikimedia.org/Gerard_(1810).jpg" }));
    expect(block).toContain("(https://upload.wikimedia.org/Gerard_%281810%29.jpg)");
    expect(block).not.toContain("<https");
  });

  it("omits the emphasis wrapper entirely when there is no credit", () => {
    expect(renderImageBlock(ref({ credit: "" }))).toBe(
      "![A battlefield](https://upload.wikimedia.org/a.jpg)",
    );
  });

  it("does not expand $ patterns in alt or credit", () => {
    // Commons extmetadata is scraped page text. A replacement STRING would expand these into
    // surrounding content; every replace in the module passes a replacer function instead.
    const block = renderImageBlock(ref({ alt: "cost $& each", credit: "see $' and $` and $$" }));
    expect(block).toContain("![cost $& each]");
    // The backtick itself is stripped as a markdown code marker; the $ survives untouched,
    // which is the thing under test.
    expect(block).toContain("*see $' and $ and $$*");
  });
});

describe("insertImages: $ patterns in the report body", () => {
  it("leaves a body containing $& and $' intact", () => {
    const report = ["## One", "", "A price of $5, a $& and a $' walk into a bar.", ""].join("\n");
    const out = insertImages(report, new Map([[0, [ref()]]]));
    expect(out).toContain("A price of $5, a $& and a $' walk into a bar.");
  });
});

describe("countImages", () => {
  it("counts images and not ordinary links", () => {
    const report = "![a](https://x/1.jpg) [not an image](https://x/page) ![b](https://x/2.jpg)";
    expect(countImages(report)).toBe(2);
  });

  it("is zero for a report with no images", () => {
    expect(countImages(REPORT)).toBe(0);
  });
});
