/**
 * Places images into a finished report's markdown.
 *
 * Pure — no network, no LLM, no filesystem — for the same reason `src/reportOutput.ts` is:
 * it makes the part of this feature that decides *where a picture lands* testable without an
 * API key, which is where the fiddly off-by-one bugs live.
 *
 * Placement is deterministic rather than model-chosen. The model picks *which* images a
 * section gets; this module decides where they go, which is the end of that section — after
 * its last line of prose and before the next heading.
 *
 * NOTE: every `replace` below passes a **replacer function**, never a replacement string.
 * Alt text and credit lines are built from Commons `extmetadata` — scraped page metadata — so
 * a `$&` or `$'` in an artist name or a museum's credit field would otherwise splice
 * surrounding report text into the output. Same hazard as `src/prompts/fillTemplate.ts` and
 * `src/reportOutput.ts`, reachable here for the same reason.
 */

import { MAX_IMAGES_PER_SECTION } from "../config.js";

/** A `##` section heading. `###` and deeper are not sections for this purpose. */
const H2 = /^##(?!#)\s+(.+)$/;

/** What ends a section: the next `#` or `##`. A `###` subsection does not. */
const BOUNDARY = /^#{1,2}(?!#)\s+/;

/**
 * Headings that get no pictures.
 *
 * `## Sources` is the one the report prompt actually asks for; the rest are the names a model
 * reaches for when it writes the same section under its own initiative. An apparatus section
 * is a list of links, and an oil painting beneath it illustrates nothing.
 */
const NOT_ILLUSTRATABLE =
  /^(sources?|references?|bibliography|further\s+reading|citations?|footnotes?|notes|appendix)\b/i;

export type ImageRef = {
  url: string;
  alt: string;
  /** Plain text, already composed — see `creditFor` in commonsImages.ts. */
  credit: string;
};

export type ReportSection = {
  /** Position among the report's `##` sections, which is how `insertImages` is keyed. */
  index: number;
  heading: string;
  /** Index of the section's last non-blank line. Images are inserted after it. */
  endLine: number;
  /** False for apparatus sections such as `## Sources`. */
  illustratable: boolean;
};

/** Strips the inline markup a heading might carry, so the apparatus test sees plain words. */
const bareHeading = (heading: string): string =>
  heading
    .replace(/[*_`#]/g, () => "")
    .replace(/\s+/g, () => " ")
    .trim();

/**
 * The report's `##` sections, in order, each with the line its content ends on.
 *
 * Exported because it is the single source of truth for section identity: the orchestrator
 * asks the model about these sections by `index`, and `insertImages` keys off the same
 * numbering. Two separate section scans would be free to disagree.
 */
export const reportSections = (report: string): ReportSection[] => {
  const lines = report.split("\n");
  const starts: { line: number; heading: string }[] = [];

  for (const [line, text] of lines.entries()) {
    const match = H2.exec(text);
    if (match) starts.push({ line, heading: match[1].trim() });
  }

  return starts.map(({ line, heading }, index) => {
    // Where this section's content stops: just before the next heading of equal or higher
    // level, or the end of the document.
    let limit = lines.length;
    for (let scan = line + 1; scan < lines.length; scan += 1) {
      if (BOUNDARY.test(lines[scan])) {
        limit = scan;
        break;
      }
    }

    // Back up over trailing blank lines so the image block sits against the prose rather than
    // after a gap — and so the blank line separating it from the next heading stays single.
    let endLine = limit - 1;
    while (endLine > line && !lines[endLine].trim()) endLine -= 1;

    return {
      index,
      heading,
      endLine,
      illustratable: !NOT_ILLUSTRATABLE.test(bareHeading(heading)),
    };
  });
};

/** Alt text cannot carry brackets or newlines without breaking out of the `![...]`. */
const sanitizeAlt = (text: string): string =>
  text
    .replace(/[[\]\\]/g, () => "")
    .replace(/\s+/g, () => " ")
    .trim();

/** A credit sits inside `*...*`, so its own emphasis characters have to go. */
const sanitizeCredit = (text: string): string =>
  text
    .replace(/[*_`\\]/g, () => "")
    .replace(/\s+/g, () => " ")
    .trim();

/**
 * Percent-encodes the three characters that would break out of a markdown `(...)` target.
 *
 * Deliberately not the CommonMark `<...>` form: `LINK_PATTERN` in `reportOutput.ts` matches
 * `([^()\s]+)`, so angle brackets would be captured as part of the URL and `new URL("<http…")`
 * would throw — degrading a perfectly good image to its alt text in the HTML rendering.
 * Encoding keeps the URL both valid and matchable.
 */
const sanitizeUrl = (url: string): string =>
  url.trim().replace(/[()\s]/g, (char) => {
    if (char === "(") return "%28";
    if (char === ")") return "%29";
    return "%20";
  });

/**
 * One image and its credit, as two markdown blocks.
 *
 * Two blocks rather than one line because the credit must render as its own paragraph:
 * markdown has no `<figure>`, and `renderBlocks` in reportOutput escapes raw HTML, so a real
 * `<figcaption>` is not available without teaching that renderer new markup.
 */
export const renderImageBlock = (ref: ImageRef): string => {
  const alt = sanitizeAlt(ref.alt);
  const credit = sanitizeCredit(ref.credit);
  const image = `![${alt}](${sanitizeUrl(ref.url)})`;
  return credit ? `${image}\n\n*${credit}*` : image;
};

/**
 * Appends each section's images to the end of that section.
 *
 * `byIndex` is keyed by `ReportSection.index`. Sections are walked back to front so that
 * splicing earlier lines cannot invalidate the line numbers of sections not yet handled.
 * An unknown index, an empty list, or more images than `MAX_IMAGES_PER_SECTION` are all
 * tolerated — the cap is enforced here as well as upstream, because this is the function that
 * actually writes them.
 */
export const insertImages = (report: string, byIndex: Map<number, ImageRef[]>): string => {
  if (!byIndex.size) return report;

  const lines = report.split("\n");
  const sections = reportSections(report);

  for (const section of [...sections].reverse()) {
    const refs = (byIndex.get(section.index) ?? []).slice(0, MAX_IMAGES_PER_SECTION);
    if (!refs.length) continue;

    const blocks = refs.map((ref) => renderImageBlock(ref));
    const rendered = blocks.flatMap((block) => ["", ...block.split("\n")]);
    lines.splice(section.endLine + 1, 0, ...rendered);
  }

  return lines.join("\n");
};

/** How many images the report embeds. Counts occurrences, not distinct URLs. */
export const countImages = (report: string): number =>
  (report.match(/!\[[^\]]*\]\([^()\s]+\)/g) ?? []).length;
