/**
 * Formatting for the finished report: the terminal outline, the saved file's name, and the
 * optional HTML rendering.
 *
 * Every function here is pure — no filesystem, no process, no console. The CLI owns all of
 * that, which is what makes this module unit-testable without driving a graph. `src/cli.ts`
 * is the only consumer.
 *
 * NOTE: every `replace` below passes a **replacer function**, never a replacement string.
 * This is the same hazard `src/prompts/fillTemplate.ts` exists to avoid, and it is reachable
 * here for the same reason: a report body is built from the user's own words and from
 * Tavily-scraped page text, so it can contain `$&`, `$'` or ``$` ``, which a replacement
 * string would expand into surrounding content. A function receives the text verbatim.
 *
 * The same untrusted-input argument is why `renderHtml` escapes before it substitutes and
 * accepts only http(s) URLs.
 */

/** `[label](url)` / `![alt](url)`, with an optional `"title"`. Group 1 is the image bang. */
const LINK_PATTERN = /(!?)\[([^\]]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** One list line: `- text`, `* text`, `1. text`, with leading indent. Not global — used with `.test`/`.exec`. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const MAX_SLUG = 60;

/**
 * Letters NFKD cannot fold, because each is a distinct letter rather than a base plus a
 * combining mark. Without these `Łódź` slugs to `odz` and `Ørland` to `rland` — and a tool
 * about armed conflict meets Polish, Scandinavian and Balkan place names constantly.
 */
const TRANSLITERATE: Record<string, string> = {
  ł: "l",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
  ß: "ss",
};

/**
 * Connectives, dropped only from a topic too long to fit whole.
 *
 * Real topics run long — "The tank engagement at Prokhorovka during the Battle of Kursk, 12
 * July 1943" overruns the cap by a third, and a blind truncation spends the budget on "at the
 * battle of" and loses Kursk and the date, which is exactly what tells one report from
 * another in a folder listing. Short topics keep their natural phrasing.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "during", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

/** Joins words with hyphens, stopping on a word boundary once the next one would overrun. */
const joinWithin = (words: string[]) => {
  let slug = "";
  for (const word of words) {
    if (!slug) {
      slug = word;
      continue;
    }
    if (slug.length + 1 + word.length > MAX_SLUG) break;
    slug += `-${word}`;
  }
  return slug.slice(0, MAX_SLUG);
};

// ============================================================ MARKDOWN → PLAIN TEXT ============================================================

/**
 * Drops a fence wrapping the whole report.
 *
 * The report prompt asks for markdown, and a model that takes that literally sometimes hands
 * back the document inside a ```markdown fence. Left alone, the fence lands in the saved file
 * verbatim. A fence that merely appears somewhere inside the report is left alone.
 */
export const stripCodeFence = (report: string): string => {
  const trimmed = report.trim();
  const opening = /^```[^\n]*\n/.exec(trimmed);
  if (!opening || !trimmed.endsWith("```")) return report;

  const body = trimmed.slice(opening[0].length, -3);
  return body.trim();
};

/** Strips inline markup so a heading can be printed to a terminal as prose. */
export const stripInline = (text: string): string =>
  text
    .replace(LINK_PATTERN, (_match, _bang: string, label: string) => label)
    .replace(/(\*\*|__)(.+?)\1/g, (_match, _delim: string, inner: string) => inner)
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, (_match, inner: string) => inner)
    .replace(/(?<![\w_])_(?!_)([^_]+)_(?![\w_])/g, (_match, inner: string) => inner)
    .replace(/`([^`]*)`/g, (_match, inner: string) => inner)
    .trim();

export type Outline = {
  /** The report's `# ` title, or "" when it has none. */
  title: string;
  /** Its `## ` section headings, in order. `###` and deeper are deliberately ignored. */
  sections: string[];
};

/**
 * Pulls the title and section headings out of a report.
 *
 * `###` subsections are left out on purpose: the reports carry enough of them to fill a
 * screen on their own, which is the thing this outline exists to avoid.
 */
export const extractOutline = (report: string): Outline => {
  let title = "";
  const sections: string[] = [];

  for (const line of report.split("\n")) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      if (!title) title = stripInline(h1[1]);
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) sections.push(stripInline(h2[1]));
  }

  return { title, sections };
};

/** How many distinct sources the report cites. Images are not sources. */
export const countSources = (report: string): number => {
  const urls = new Set<string>();
  for (const [, bang, , url] of report.matchAll(LINK_PATTERN)) {
    if (bang !== "!") urls.add(url);
  }
  return urls.size;
};

export const countWords = (report: string): number => {
  const trimmed = report.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

// ============================================================ FILE NAMING ============================================================

/**
 * `battle-of-austerlitz` — lowercase, ASCII, hyphenated, at most MAX_SLUG characters.
 *
 * A topic that fits is kept verbatim. One that does not has its connectives dropped first and
 * is then truncated on a word boundary rather than mid-word, so the name still reads. Returns
 * "" for a topic with no alphanumerics at all, which is the caller's signal to fall back.
 */
export const slugify = (topic: string): string => {
  const words = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, () => "") // combining marks left behind by NFKD
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, (char) => TRANSLITERATE[char] ?? char)
    .replace(/['’]/g, () => "") // Napoleon's -> napoleons, not napoleon-s
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const whole = words.join("-");
  if (whole.length <= MAX_SLUG) return whole;

  const significant = words.filter((word) => !STOPWORDS.has(word));
  return joinWithin(significant.length ? significant : words);
};

/**
 * `2026-10-11` in the machine's own timezone.
 *
 * Not `toISOString().slice(0, 10)`: that is UTC, so a report written at 19:24 on the 11th
 * anywhere west of Greenwich is named for the 12th — a date the user never worked on it.
 */
const localDate = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

/**
 * The old name: a full ISO timestamp with the colons and dot made filesystem-safe.
 *
 * Deliberately still UTC where `localDate` is not — this is a fallback for a report with no
 * topic to name it after, and the trailing `Z` says plainly which zone it is in.
 */
export const timestampName = (date: Date): string => date.toISOString().replace(/[:.]/g, () => "-");

/**
 * The report file's base name, without extension: `2026-10-11-battle-of-austerlitz`.
 *
 * Falls back to the bare timestamp when there is no plan to name it after, or when the topic
 * slugs to nothing — naming a file must never be the thing that loses a finished report.
 */
export const reportBaseName = (plan: { final_topic?: string } | null | undefined, date: Date): string => {
  const slug = plan?.final_topic ? slugify(plan.final_topic) : "";
  return slug ? `${localDate(date)}-${slug}` : timestampName(date);
};

// ============================================================ MARKDOWN → HTML ============================================================

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * Escapes before any markup is substituted, so the tags this module inserts are the only
 * tags in the output. Quotes are escaped too because URLs end up inside an href attribute.
 */
const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (char) => ENTITIES[char] ?? char);

/**
 * Accepts only http(s), and only a URL that actually parses.
 *
 * Report URLs come from scraped pages, so `javascript:` is a real possibility rather than a
 * theoretical one. A rejected URL degrades to its label as plain text.
 *
 * The input is already HTML-escaped, which is fine on both counts: `&amp;` is legal in a URL
 * and decodes back to `&` when the browser reads the attribute.
 */
const safeUrl = (raw: string): string | undefined => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
};

/** `**bold**`, `*italic*`, `_italic_`, `` `code` `` — on already-escaped text. */
const emphasis = (escaped: string): string =>
  escaped
    .replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
    .replace(/(\*\*|__)(.+?)\1/g, (_match, _delim: string, inner: string) => `<strong>${inner}</strong>`)
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, (_match, inner: string) => `<em>${inner}</em>`)
    .replace(/(?<![\w_])_(?!_)([^_]+)_(?![\w_])/g, (_match, inner: string) => `<em>${inner}</em>`);

/**
 * Inline markup, on already-escaped text.
 *
 * Links are lifted out to NUL-delimited placeholders before emphasis runs and spliced back
 * afterwards. Otherwise the emphasis pass would be free to rewrite the inside of an href — a
 * URL containing `**` or `_` is unusual but not impossible, and a mangled citation is worse
 * than the complexity of a placeholder.
 */
const renderInline = (escaped: string): string => {
  const links: string[] = [];

  const parked = escaped.replace(LINK_PATTERN, (_match, bang: string, label: string, rawUrl: string) => {
    const url = safeUrl(rawUrl);
    const token = `\u0000${links.length}\u0000`;

    if (bang === "!") {
      links.push(url ? `<img src="${url}" alt="${label}">` : emphasis(label));
    } else {
      links.push(url ? `<a href="${url}" target="_blank" rel="noopener">${emphasis(label)}</a>` : emphasis(label));
    }
    return token;
  });

  return emphasis(parked).replace(/\u0000(\d+)\u0000/g, (_match, index: string) => links[Number(index)] ?? "");
};

type ListItem = { indent: number; ordered: boolean; text: string };

/**
 * Renders one run of list lines, recursing into each deeper-indented run.
 *
 * A nested list is spliced inside its parent `<li>` rather than emitted as a sibling, which
 * browsers tolerate but validators do not. Returns where the run ended so the caller can
 * carry on from there.
 */
const renderList = (items: ListItem[], start: number, indent: number): { html: string; next: number } => {
  const tag = items[start].ordered ? "ol" : "ul";
  const rendered: string[] = [];
  let i = start;

  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent > indent) {
      const nested = renderList(items, i, items[i].indent);
      // An over-indented first item has no parent to nest inside; give it one.
      if (!rendered.length) rendered.push("<li></li>");
      rendered[rendered.length - 1] = rendered[rendered.length - 1].replace(
        /<\/li>$/,
        () => `\n${nested.html}\n</li>`,
      );
      i = nested.next;
      continue;
    }
    rendered.push(`<li>${renderInline(escapeHtml(items[i].text))}</li>`);
    i += 1;
  }

  return { html: `<${tag}>\n${rendered.join("\n")}\n</${tag}>`, next: i };
};

const startsBlock = (line: string): boolean =>
  /^#{1,6}\s/.test(line) || LIST_ITEM.test(line) || line.trimStart().startsWith(">");

/** Block-level markdown: headings, lists, blockquotes, rules, paragraphs. */
const renderBlocks = (markdown: string): string => {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    // Before the list check: `- - -` is a rule, not a one-item list.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (!item) break;
        items.push({ indent: item[1].length, ordered: /\d/.test(item[2]), text: item[3] });
        i += 1;
      }
      html.push(renderList(items, 0, items[0].indent).html);
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quote.push(lines[i].trimStart().replace(/^>\s?/, () => ""));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(escapeHtml(quote.join(" ")))}</blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    html.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
  }

  return html.join("\n");
};

const STYLE = `
  :root { color-scheme: light dark; --ink: #1a1a1a; --bg: #fdfdfc; --muted: #666; --rule: #e0ddd8; --link: #0b5cad; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6e3dd; --bg: #16161a; --muted: #9a958c; --rule: #33323a; --link: #7fb7f0; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 4rem 1.5rem 6rem; max-width: 46rem;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--ink); background: var(--bg); text-rendering: optimizeLegibility;
  }
  h1 { font-size: 2rem; line-height: 1.25; margin: 0 0 2rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.4rem; margin: 3rem 0 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--rule); }
  h3 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
  h4, h5, h6 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
  p, li { overflow-wrap: break-word; }
  ul, ol { padding-left: 1.5rem; }
  li { margin: 0.35rem 0; }
  a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  code { font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--muted); }
  hr { margin: 2.5rem 0; border: 0; border-top: 1px solid var(--rule); }
  img { max-width: 100%; height: auto; }
  footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.85rem; }
  @media print {
    body { max-width: none; padding: 0; color: #000; background: #fff; }
    a { color: #000; }
    h2 { break-after: avoid; }
    footer { display: none; }
  }
`;

/**
 * A self-contained HTML rendering of the report.
 *
 * Self-contained on purpose: no CDN, no external stylesheet, so the file still reads offline
 * and survives being emailed or printed to PDF. `title` is only the document title — the
 * report's own `# ` heading is rendered from the markdown like everything else.
 */
export const renderHtml = (report: string, title: string): string => {
  const sources = countSources(report);
  const words = countWords(report);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || "War Research report")}</title>
<style>${STYLE}</style>
</head>
<body>
${renderBlocks(report)}
<footer>${words.toLocaleString("en-US")} words · ${sources} source${sources === 1 ? "" : "s"} · generated by War Research</footer>
</body>
</html>
`;
};
