/**
 * Wikimedia Commons image search — the pipeline's only image source.
 *
 * Commons was chosen over web image search (Tavily's `includeImages`) and over museum APIs
 * because it is the one source that answers all four of the categories a war report wants —
 * battle paintings, weapons, museum relics, wartime photographs — through a single
 * unauthenticated endpoint, *with* the author and licence fields a credit line needs. It also
 * federates a great deal of museum material already: the Smithsonian's Brown Bess studio
 * photographs and the Warsaw National Museum's Austerlitz canvas both arrive this way.
 *
 * Four behaviours here are load-bearing, each measured rather than assumed:
 *
 *  1. **Queries must be 2-4 keywords, not sentences.** Commons' search is effectively
 *     conjunctive, so a natural-language phrase returns nothing even when the subject is
 *     thoroughly documented: `Prokhorovka tank engagement July 1943` → 0 results,
 *     `Prokhorovka` → 3. `searchWithBackoff` exists for exactly this, and the query prompt
 *     tells the model to name the thing rather than describe it.
 *
 *  2. **The rate-limit response is PLAIN TEXT.** Exceed it and the body is
 *     "You are making too many requests to the API.", so an unguarded `JSON.parse` throws
 *     rather than returning an error object. Every parse here is guarded and every failure
 *     degrades to an empty result — illustration is best-effort and must never be able to
 *     lose a report that cost a full research run.
 *
 *  3. **Use `thumburl`, never `url`, and ask for `thumbmime`.** The originals are
 *     hotlink-hostile (the Gérard Austerlitz canvas is 4000x1983) and may be in formats no
 *     browser renders inline — Commons holds SVG maps and TIFF scans, the Library of Congress
 *     Gettysburg troop maps among them. The thumbnailer renders both to PNG, so the mime check
 *     reads `thumbmime` in preference to `mime`. The trap: **the API omits `thumbmime` unless
 *     `iiprop` names it.** Drop it from that list and the check silently falls back to the
 *     original's format, rejecting every SVG and TIFF — which is exactly the bug that kept
 *     SVG battle maps out until it was measured. A unit test pins the request shape for that
 *     reason, because a fixture can supply a field the real request never asked for.
 *
 *  4. **Relevance order is kept, not re-sorted.** Top-1 is not safe — `Prokhorovka tank
 *     battle` ranked a tourist photograph of a bird nesting in a gun barrel first — so the
 *     ordering is handed to the picking model as a hint and the model does the rejecting.
 *     Re-sorting by size here would only destroy that hint.
 */

import {
  COMMONS_MIN_INTERVAL_MS,
  IMAGE_THUMB_WIDTH,
  MIN_IMAGE_LONG_EDGE,
} from "../config.js";

const API = "https://commons.wikimedia.org/w/api.php";

// Wikimedia asks every client to identify itself and throttles generic agents harder.
const USER_AGENT = "war-research/0.1 (research report illustration; +https://github.com/fuhuan1991)";

/**
 * Thumbnail formats a browser renders inline. This is tested against `thumbmime`, so an SVG
 * or TIFF *source* passes on the strength of its rendered PNG thumbnail; a PDF or video does
 * not, and `filetype:bitmap|drawing` keeps those out of the search to begin with.
 */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Dropped when shortening a query: they are capitalised but name nothing searchable. */
const NOT_A_SUBJECT = new Set([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
  "The", "A", "An", "Of", "At", "In", "On", "During",
]);

export type ImageCandidate = {
  /** The Commons file title. Stable identity, used to de-duplicate across sections. */
  id: string;
  /** The thumbnail URL, tracking parameters stripped. This is what the report hotlinks. */
  url: string;
  /** The Commons file page, for a human chasing provenance. Not linked in the report. */
  descriptionUrl: string;
  /** Dimensions of the ORIGINAL, which is what MIN_IMAGE_LONG_EDGE judges. */
  width: number;
  height: number;
  /** The file title, cleaned: no "File:" prefix, no extension, underscores spaced out. */
  title: string;
  artist?: string;
  licence?: string;
  credit?: string;
};

export type ImageSearchFn = (query: string, limit: number) => Promise<ImageCandidate[]>;

// ============================================================ TEXT CLEANUP ============================================================

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * `extmetadata` values are HTML fragments — an artist is routinely wrapped in an `<a>` — so
 * they are reduced to plain text before they can reach a markdown credit line.
 *
 * Replacer functions throughout, never replacement strings: these values are scraped page
 * metadata, so a `$'` or `$&` in a museum's credit field would otherwise splice surrounding
 * text into the output. Same hazard `src/prompts/fillTemplate.ts` exists to avoid.
 */
const plainText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, () => " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, () => " ")
    .trim();

/** `File:Brown_Bess_Musket-NMAH.jpg` → `Brown Bess Musket-NMAH`. */
const cleanTitle = (pageTitle: string): string =>
  pageTitle
    .replace(/^File:/i, () => "")
    .replace(/\.(jpe?g|png|webp|gif|tiff?|svg)$/i, () => "")
    .replace(/_/g, () => " ")
    .trim();

/**
 * Removes the `utm_source` / `utm_campaign` / `utm_content` parameters the API appends to
 * every URL it returns. They are harmless but they are tracking, and they make a hotlinked
 * URL in a saved report longer and stranger than it needs to be.
 */
const stripTracking = (raw: string): string => {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
};

/**
 * The credit line rendered beneath an image.
 *
 * Unlinked on purpose: `countSources` in reportOutput counts every `[](...)` in the report,
 * so a linked credit would inflate the source count with something that is not a source.
 * Author plus licence in plain text still satisfies CC BY-SA attribution, which the
 * Bundesarchiv photographs genuinely require rather than merely appreciate.
 *
 * A long `credit` field is dropped rather than truncated — Commons' can run to a full
 * sentence about digitisation provenance, which is not what a caption is for.
 */
export const creditFor = (candidate: ImageCandidate): string => {
  const head: string[] = [];
  if (candidate.artist) head.push(candidate.artist);
  head.push(`“${candidate.title}”`);
  if (candidate.credit && candidate.credit.length <= 60) head.push(candidate.credit);

  const licence = candidate.licence ? `${candidate.licence} via Wikimedia Commons` : "via Wikimedia Commons";
  return `${head.join(" — ")}. ${licence}.`;
};

// ============================================================ TRANSPORT ============================================================

let intervalMs = COMMONS_MIN_INTERVAL_MS;
let nextSlot = 0;

/**
 * Tests only. Removes the inter-request delay so a mocked suite does not sleep through it,
 * and clears the slot the previous test left behind.
 */
export const setRequestIntervalForTests = (ms: number): void => {
  intervalMs = ms;
  nextSlot = 0;
};

/**
 * Serialises requests to at most one per `intervalMs`.
 *
 * Reserving the slot synchronously — before any await — is what makes this work under the
 * parallel calls the orchestrator makes: each caller claims the next slot and then sleeps
 * until it, so N concurrent callers space themselves out instead of all seeing the same
 * "last request" timestamp. The same single-threaded claim-before-yielding argument as the
 * `seen` Set in tavilySearch.ts.
 */
const takeSlot = async (): Promise<void> => {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + intervalMs;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
};

/** One GET against the API. Returns undefined for any failure, including a non-JSON body. */
const getJson = async (params: Record<string, string>): Promise<unknown | undefined> => {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  await takeSlot();

  let body: string;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    body = await response.text();
  } catch (err) {
    console.warn(`Commons request failed: ${(err as Error).message}`);
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    // The rate-limit response lands here: a plain-text body, not an API error object.
    console.warn(`Commons returned a non-JSON body: ${body.slice(0, 80)}`);
    return undefined;
  }
};

// ============================================================ SEARCH ============================================================

type RawImageInfo = {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  mime?: string;
  thumbmime?: string;
  extmetadata?: Record<string, { value?: unknown }>;
};

/**
 * Values that name nothing. Commons records an absent author as "Unknown source" rather than
 * omitting the field, and a caption reading "Unknown source. Public domain via Wikimedia
 * Commons." is worse than one that simply names the work. Nothing is lost legally either:
 * a CC licence asks for the author to be named, and these are the cases where there is none.
 */
const UNINFORMATIVE =
  /^(unknown(\s+(source|author|artist|photographer|painter))?|own\s+work|anonymous|not\s+(known|specified)|unspecified|n\/?a|none|see\s+(above|below))\.?$/i;

/**
 * Collapses a value Commons has doubled.
 *
 * Measured on the live API: the `Credit` field for a Lejeune Austerlitz canvas arrives as a
 * `<span>Unknown source</span>Unknown source`, so stripping the tags leaves the text twice.
 * Length-guarded because the backreference is the one pattern here that could backtrack.
 */
const collapseRepeat = (text: string): string => {
  if (text.length > 200) return text;
  const doubled = /^(.+?)\s*\1$/.exec(text);
  return doubled ? doubled[1].trim() : text;
};

const metaField = (info: RawImageInfo, key: string): string | undefined => {
  const raw = info.extmetadata?.[key]?.value;
  if (typeof raw !== "string") return undefined;

  const text = collapseRepeat(plainText(raw));
  if (!text || UNINFORMATIVE.test(text)) return undefined;
  return text;
};

const toCandidate = (pageTitle: string, info: RawImageInfo): ImageCandidate | undefined => {
  const url = info.thumburl ?? info.url;
  const width = info.width;
  const height = info.height;
  if (!url || typeof width !== "number" || typeof height !== "number") return undefined;

  // thumbmime first: a TIFF original is served as a JPEG thumbnail, and it is the thumbnail
  // the report hotlinks.
  if (!ALLOWED_MIME.has(info.thumbmime ?? info.mime ?? "")) return undefined;

  // The long edge, not the width — see MIN_IMAGE_LONG_EDGE for the measurement behind that.
  if (Math.max(width, height) < MIN_IMAGE_LONG_EDGE) return undefined;

  return {
    id: pageTitle,
    url: stripTracking(url),
    descriptionUrl: stripTracking(info.descriptionurl ?? ""),
    width,
    height,
    title: cleanTitle(pageTitle),
    artist: metaField(info, "Artist"),
    licence: metaField(info, "LicenseShortName"),
    credit: metaField(info, "Credit"),
  };
};

/**
 * One Commons search. Returns candidates in the API's own relevance order, filtered for size
 * and renderable format. Never throws: an empty array is the failure value.
 */
export const searchCommonsImages: ImageSearchFn = async (query, limit) => {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const data = await getJson({
    action: "query",
    format: "json",
    formatversion: "1",
    generator: "search",
    // `filetype:bitmap|drawing` plus namespace 6 keeps PDFs, audio and video out while
    // admitting SVG, which is what a great many of the best battle maps are. `drawing` was
    // measured not to let junk back in: "Brown Bess musket" returns the identical Smithsonian
    // set either way, so the "no junk in 112 results" finding behind the gentle size floor
    // still holds.
    gsrsearch: `filetype:bitmap|drawing ${trimmed}`,
    gsrnamespace: "6",
    gsrlimit: String(Math.max(1, limit)),
    prop: "imageinfo",
    // `thumbmime` MUST be listed here. The API omits it unless asked, and without it
    // `toCandidate` falls back to the ORIGINAL's mime and rejects every SVG and TIFF whose
    // thumbnail is a perfectly renderable PNG. Verified against the live API both ways.
    iiprop: "url|size|mime|thumbmime|extmetadata",
    iiurlwidth: String(IMAGE_THUMB_WIDTH),
  });

  const pages = (data as { query?: { pages?: Record<string, unknown> } } | undefined)?.query?.pages;
  if (!pages) return [];

  const candidates: ImageCandidate[] = [];
  for (const page of Object.values(pages)) {
    const { title, imageinfo } = page as { title?: string; imageinfo?: RawImageInfo[] };
    if (!title || !imageinfo?.length) continue;
    const candidate = toCandidate(title, imageinfo[0]);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
};

/**
 * Shortens a query to its proper nouns, for a second attempt when the first found nothing.
 *
 * Returns "" when there is nothing useful left to try, which the caller reads as "do not
 * retry" — re-running the same words costs a request and cannot produce a different answer.
 */
export const shortenQuery = (query: string): string => {
  const tokens = query.trim().split(/\s+/).filter(Boolean);

  const proper = tokens
    .filter((token) => /^[A-ZÀ-Þ]/.test(token) && !NOT_A_SUBJECT.has(token))
    .slice(0, 3);

  const shortened = (proper.length ? proper : tokens.slice(0, 2)).join(" ");
  return shortened && shortened !== query.trim() ? shortened : "";
};

/**
 * `searchCommonsImages`, retried once with a shortened query when the first attempt finds
 * nothing. This is the measured failure mode — see note 1 in the module header — and it is
 * the difference between illustrating an angle and silently skipping it.
 */
export const searchWithBackoff: ImageSearchFn = async (query, limit) => {
  const first = await searchCommonsImages(query, limit);
  if (first.length) return first;

  const shortened = shortenQuery(query);
  if (!shortened) return [];

  console.warn(`Commons: no results for "${query}", retrying as "${shortened}"`);
  return searchCommonsImages(shortened, limit);
};

/**
 * Whether a chosen URL actually serves an image.
 *
 * Commons' thumbnailer occasionally fails to render an exotic source, and the cost of not
 * checking is a broken-image icon in a finished report where a clean omission would do. The
 * request goes to the image host rather than the API, so it does not consume the API's rate
 * budget and is not throttled here.
 */
export const imageIsReachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
    const type = response.headers.get("content-type") ?? "";
    return response.ok && type.startsWith("image/");
  } catch {
    return false;
  }
};
