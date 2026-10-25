export const TAVILY_MAX_RESULTS = 4;

// Hard ceiling on the raw page text handed to miniModel for summarisation.
export const MAX_RAW_CONTENT_CHARS = 200_000;

// --- Pre-research phase (scoping and plan confirmation) ---

// How many suggestive nudges the user gets before the graph gives up and ends.
export const MAX_CLARIFY_ROUNDS = 3;

// How many plans the user may reject before the next one is auto-accepted.
export const MAX_CONFIRM_ROUNDS = 6;

// Upper bound on how many angles a proposed plan carries. Each angle is intended to become
// one ConductResearch call, so this is deliberately aligned with MAX_CONCURRENT_RESEARCH_UNITS.
//
// It is a ceiling, not a quota: propose_plan may return fewer. A topic that only supports two
// angles worth researching should get two, because a padded third is a wasted researcher and
// a report section that says nothing.
export const MAX_ANGLES_PER_PLAN = 3;

// --- Research phase ---

export const MAX_SUPERVISOR_TURNS = 5;
export const MAX_CONCURRENT_RESEARCH_UNITS = 3;

export const MAX_RESEARCHER_TURNS = 5;
export const MAX_CONCURRENT_TAVILY_SEARCHES = 4;

// --- Report illustration (Wikimedia Commons) ---

// How many images may be appended to one section of the finished report. A ceiling, not a
// quota: a section whose subject has no usable imagery gets none rather than a filler.
export const MAX_IMAGES_PER_SECTION = 2;

// Size floor, applied to an image's LONG edge — deliberately not its width.
//
// Measured over 112 Commons results across 12 queries (battle paintings, weapons, museum
// relics, wartime photographs). A long-edge cut of 640 rejects 6, and all six deserve it: a
// 487x219 letterboxed sliver, a 442x601 scan of a newspaper column, a 399x564 photograph of
// a cathedral.
//
// The obvious `width >= 800` instead rejects 15, and 9 of those are good images penalised
// only for being tall: all three 517x1044 Sutton Hoo helmet shots — a museum relic, which is
// exactly what this feature is for — and a 788x501 Bundesarchiv Panzer VI that misses the cut
// by 12 pixels. A short-edge cut is worse still: at 640 it drops 29% of results, gutting the
// Bundesarchiv 800x~550 photographs entirely.
//
// Note this is a quality floor, not a junk filter. `gsrnamespace=6` plus `filetype:bitmap`
// returned zero logos, icons, sprites or avatars across all 112 results, so there is no junk
// to exclude and the cut should stay gentle — rejecting bad *subjects* is the picking model's
// job, not this constant's. For reference, reportOutput's HTML body is 46rem (~736px) wide,
// so anything clearing 640 renders at near-full column width anyway.
export const MIN_IMAGE_LONG_EDGE = 640;

// How many candidates to fetch per query. Over-fetching is what makes the picking model worth
// its call: Commons' relevance ranking is literal, and "Prokhorovka tank battle" ranked a
// tourist photograph of a bird nesting in a gun barrel first.
export const IMAGE_CANDIDATES_PER_QUERY = 8;

// Width requested from Commons' thumbnailer via `iiurlwidth`.
//
// Two jobs. The originals are unusable for hotlinking — the Gérard Austerlitz canvas is
// 4000x1983 and several megabytes — and the thumbnailer renders SVG and TIFF sources to PNG,
// so an SVG battle map or a Library of Congress TIFF scan arrives in a format a browser will
// actually show inline. (That second job only works if `iiprop` asks for `thumbmime`; see the
// note on it in commonsImages.ts.)
//
// 1600 rather than 960 because of maps. A painting reads fine at 960 scaled into the HTML's
// 46rem (~736px) column, but battle maps are detail-dense and enormous — measured at
// 4950x5917 for the Gettysburg day maps and 3752x2896 for the Austerlitz hourly situation
// maps — and their troop labels are illegible once a 4950px original has been squeezed to
// 736px. The larger thumbnail costs nothing in storage, since images are hotlinked, and
// `max-width: 100%` still fits it to the column; it just leaves something to see when the
// reader zooms the page or opens the image on its own.
export const IMAGE_THUMB_WIDTH = 1600;

// Minimum spacing between Commons API requests.
//
// The API rate-limits, and answers in PLAIN TEXT when it does ("You are making too many
// requests to the API."), which is why commonsImages.ts guards every JSON.parse rather than
// trusting the body. Measured: 1.2s spacing failed on the 11th request of a burst, 2.5s
// failed once in 13.
export const COMMONS_MIN_INTERVAL_MS = 1500;

// Ceiling on Commons queries per report — a cost and latency bound. MAX_ANGLES_PER_PLAN
// sections at MAX_IMAGES_PER_SECTION queries each already fits inside this, so it only bites
// when the query model over-produces.
export const MAX_IMAGE_QUERIES_PER_REPORT = 8;
