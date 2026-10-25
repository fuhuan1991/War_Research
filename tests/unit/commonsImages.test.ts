import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  creditFor,
  imageIsReachable,
  searchCommonsImages,
  searchWithBackoff,
  setRequestIntervalForTests,
  shortenQuery,
  type ImageCandidate,
} from "../../src/images/commonsImages.js";
import { MIN_IMAGE_LONG_EDGE } from "../../src/config.js";

// =============================================================================
// The Wikimedia Commons client, with `fetch` stubbed.
//
// The cases that matter are the degradations: the rate limit answers in PLAIN TEXT, so an
// unguarded JSON.parse would throw inside a report run; and the size/format filters are
// what keep a letterboxed sliver or a hotlinked TIFF out of a finished report.
// =============================================================================

/** One imageinfo entry as the live API returns it, with extmetadata as HTML fragments. */
const imageInfo = (overrides: Record<string, unknown> = {}) => ({
  url: "https://upload.wikimedia.org/wikipedia/commons/b/ba/Gerard.jpg?utm_source=commons.wikimedia.org",
  thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Gerard.jpg/960px-Gerard.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo",
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Gerard.jpg",
  width: 4000,
  height: 1983,
  mime: "image/jpeg",
  thumbmime: "image/jpeg",
  extmetadata: {
    Artist: { value: '<a href="//commons.wikimedia.org/wiki/X">François Gérard</a>' },
    LicenseShortName: { value: "Public domain" },
    Credit: { value: "National Museum in Warsaw" },
  },
  ...overrides,
});

const apiResponse = (pages: Record<string, unknown>) => ({ query: { pages } });

/** A requested URL, readable: URLSearchParams encodes spaces as `+`, which decoding leaves. */
const readUrl = (raw: string) => decodeURIComponent(raw).replace(/\+/g, () => " ");

const onePage = (title: string, info: Record<string, unknown> = {}) =>
  apiResponse({ "123": { title, imageinfo: [imageInfo(info)] } });

/** Queues bodies, one per fetch call, so a backoff retry can be given a different answer. */
const stubFetch = (...bodies: (string | object)[]) => {
  const calls: string[] = [];
  const queue = [...bodies];
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    const body = queue.length > 1 ? queue.shift()! : queue[0];
    return { ok: true, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
};

beforeEach(() => {
  // Without this the module's real 1.5s spacing would make this suite sleep for a minute.
  setRequestIntervalForTests(0);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchCommonsImages: parsing", () => {
  it("maps a page into a candidate, HTML-stripped and tracking-free", async () => {
    stubFetch(onePage("File:Gerard_Austerlitz.jpg"));

    const [candidate] = await searchCommonsImages("Battle of Austerlitz painting", 8);

    expect(candidate).toMatchObject({
      id: "File:Gerard_Austerlitz.jpg",
      title: "Gerard Austerlitz",
      width: 4000,
      height: 1983,
      artist: "François Gérard",
      licence: "Public domain",
      credit: "National Museum in Warsaw",
    });
    expect(candidate.url).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Gerard.jpg/960px-Gerard.jpg",
    );
  });

  it("prefers the thumbnail over the original", async () => {
    // The originals are multi-megabyte and sometimes in formats browsers will not render.
    stubFetch(onePage("File:X.jpg"));
    const [candidate] = await searchCommonsImages("x", 8);
    expect(candidate.url).toContain("960px-");
  });

  it("sends a namespace-6 search for bitmaps and drawings with a thumbnail width", async () => {
    const { calls } = stubFetch(onePage("File:X.jpg"));
    await searchCommonsImages("Brown Bess musket", 5);

    const url = readUrl(calls[0]);
    // `drawing` admits SVG, which many of the best battle maps are. Measured not to let junk
    // back in: this same query returns the identical Smithsonian set either way.
    expect(url).toContain("gsrsearch=filetype:bitmap|drawing Brown Bess musket");
    expect(url).toContain("gsrnamespace=6");
    expect(url).toContain("gsrlimit=5");
    expect(url).toContain("iiurlwidth=");
  });

  it("ASKS for thumbmime, which the API omits unless named", async () => {
    // This asserts the REQUEST, not the response, and that is the whole point. The API returns
    // thumbmime only when iiprop lists it; without it `toCandidate` falls back to the
    // original's mime and rejects every SVG and TIFF whose thumbnail is a renderable PNG.
    // A fixture can hand the parser a field the real request never asked for, so a
    // response-only test cannot catch that — this one can.
    const { calls } = stubFetch(onePage("File:X.jpg"));
    await searchCommonsImages("x", 5);
    expect(readUrl(calls[0])).toContain("thumbmime");
  });

  it("makes no request at all for a blank query", async () => {
    const { fetchMock } = stubFetch(onePage("File:X.jpg"));
    expect(await searchCommonsImages("   ", 8)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchCommonsImages: metadata that names nothing", () => {
  it("collapses a value Commons has doubled", async () => {
    // Measured live: Credit arrives as <span>X</span>X, so stripping tags leaves X twice.
    stubFetch(onePage("File:X.jpg", {
      extmetadata: { Credit: { value: '<span class="x">Bundesarchiv</span>Bundesarchiv' } },
    }));
    const [candidate] = await searchCommonsImages("x", 8);
    expect(candidate.credit).toBe("Bundesarchiv");
  });

  it.each(["Unknown source", "unknown", "Own work", "Anonymous", "n/a", "See below"])(
    "drops %s rather than printing it in a caption",
    async (value) => {
      stubFetch(onePage("File:X.jpg", {
        extmetadata: { Artist: { value }, Credit: { value } },
      }));
      const [candidate] = await searchCommonsImages("x", 8);
      expect(candidate.artist).toBeUndefined();
      expect(candidate.credit).toBeUndefined();
    },
  );

  it("drops a doubled uninformative value, which is how it actually arrives", async () => {
    stubFetch(onePage("File:X.jpg", {
      extmetadata: { Credit: { value: "<span>Unknown source</span>Unknown source" } },
    }));
    const [candidate] = await searchCommonsImages("x", 8);
    expect(candidate.credit).toBeUndefined();
  });

  it("keeps a real artist whose name merely contains a dropped word", async () => {
    stubFetch(onePage("File:X.jpg", {
      extmetadata: { Artist: { value: "Unknown Master of the Bavarian Court" } },
    }));
    const [candidate] = await searchCommonsImages("x", 8);
    expect(candidate.artist).toBe("Unknown Master of the Bavarian Court");
  });
});

describe("searchCommonsImages: filtering", () => {
  it("rejects an image whose long edge is under the floor", async () => {
    // The measured example: a 487x219 letterboxed sliver of a battle painting.
    stubFetch(onePage("File:Sliver.jpg", { width: 487, height: 219 }));
    expect(await searchCommonsImages("x", 8)).toEqual([]);
  });

  it("keeps a tall image that a width-based filter would have dropped", async () => {
    // 517x1044 — the Sutton Hoo helmet. MIN_IMAGE_LONG_EDGE is a long-edge test precisely so
    // that a museum relic photographed upright is not thrown away for being narrow.
    stubFetch(onePage("File:Helmet.jpg", { width: 517, height: 1044 }));
    expect(await searchCommonsImages("x", 8)).toHaveLength(1);
  });

  it("keeps an image sitting exactly on the floor", async () => {
    stubFetch(onePage("File:Edge.jpg", { width: MIN_IMAGE_LONG_EDGE, height: 400 }));
    expect(await searchCommonsImages("x", 8)).toHaveLength(1);
  });

  it("keeps a TIFF original because the thumbnail is a PNG", async () => {
    // Commons holds TIFFs — the Library of Congress Gettysburg troop maps among them — and no
    // browser renders a hotlinked one. The thumbnailer's output is what the report embeds.
    // These are the values the live API returns for that exact file.
    stubFetch(onePage("File:LOC.tif", { mime: "image/tiff", thumbmime: "image/png" }));
    expect(await searchCommonsImages("x", 8)).toHaveLength(1);
  });

  it("keeps an SVG map because the thumbnail is a PNG", async () => {
    // The case that mattered for maps: a great many Commons battle maps are SVG, and every
    // one of them reports thumbmime=image/png. Live values for Waterloo Campaign map-alt3.svg.
    stubFetch(onePage("File:Waterloo Campaign map-alt3.svg", {
      mime: "image/svg+xml",
      thumbmime: "image/png",
      width: 1500,
      height: 1706,
    }));
    expect(await searchCommonsImages("Waterloo campaign map", 8)).toHaveLength(1);
  });

  it("falls back to the original mime when the thumbnail's is absent", async () => {
    // Defensive: if thumbmime ever goes missing from the response, a JPEG must still pass
    // rather than every result being dropped.
    stubFetch(onePage("File:X.jpg", { mime: "image/jpeg", thumbmime: undefined }));
    expect(await searchCommonsImages("x", 8)).toHaveLength(1);
  });

  it("rejects a thumbnail in a format no browser renders inline", async () => {
    // The check is on the THUMBNAIL. An SVG source is fine (its thumb is a PNG); a thumbnail
    // that is itself SVG, or a PDF, is not.
    stubFetch(onePage("File:Doc.pdf", { mime: "application/pdf", thumbmime: "application/pdf" }));
    expect(await searchCommonsImages("x", 8)).toEqual([]);
  });

  it("rejects a page with no dimensions rather than guessing", async () => {
    stubFetch(onePage("File:X.jpg", { width: undefined, height: undefined }));
    expect(await searchCommonsImages("x", 8)).toEqual([]);
  });
});

describe("searchCommonsImages: failure degrades to empty", () => {
  it("survives the rate limit, which answers in plain text and not JSON", async () => {
    stubFetch("You are making too many requests to the API.\nPlease follow the guidelines.");
    await expect(searchCommonsImages("x", 8)).resolves.toEqual([]);
  });

  it("survives a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    await expect(searchCommonsImages("x", 8)).resolves.toEqual([]);
  });

  it("survives a response with no pages", async () => {
    stubFetch({ batchcomplete: "" });
    await expect(searchCommonsImages("x", 8)).resolves.toEqual([]);
  });
});

describe("shortenQuery", () => {
  it.each([
    ["Prokhorovka tank engagement July 1943", "Prokhorovka"],
    ["British Expeditionary Force ration scales 1914", "British Expeditionary Force"],
    ["the siege of the city", "the siege"],
  ])("%s -> %s", (query, expected) => {
    expect(shortenQuery(query)).toBe(expected);
  });

  it("returns nothing when there is no shorter query to try", () => {
    // The caller reads "" as "do not retry": the same words cost a request and cannot
    // produce a different answer.
    expect(shortenQuery("Prokhorovka")).toBe("");
    expect(shortenQuery("")).toBe("");
  });
});

describe("searchWithBackoff", () => {
  it("retries with the shortened query when the full one finds nothing", async () => {
    // The measured failure: Commons matches all words, so the long form returns zero.
    const { calls } = stubFetch(apiResponse({}), onePage("File:Prokhorovka.jpg"));

    const results = await searchWithBackoff("Prokhorovka tank engagement July 1943", 8);

    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(readUrl(calls[1])).toContain("gsrsearch=filetype:bitmap|drawing Prokhorovka");
  });

  it("does not retry when the first attempt succeeded", async () => {
    const { calls } = stubFetch(onePage("File:X.jpg"));
    await searchWithBackoff("Battle of Austerlitz painting", 8);
    expect(calls).toHaveLength(1);
  });

  it("does not retry when there is no shorter query", async () => {
    const { calls } = stubFetch(apiResponse({}));
    expect(await searchWithBackoff("Prokhorovka", 8)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("creditFor", () => {
  const candidate = (overrides: Partial<ImageCandidate> = {}): ImageCandidate => ({
    id: "File:X.jpg",
    url: "https://upload.wikimedia.org/x.jpg",
    descriptionUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
    width: 1000,
    height: 800,
    title: "A Battle",
    ...overrides,
  });

  it("names the artist, the work and the licence", () => {
    expect(creditFor(candidate({ artist: "François Gérard", licence: "Public domain" }))).toBe(
      "François Gérard — “A Battle”. Public domain via Wikimedia Commons.",
    );
  });

  it("includes a short institutional credit", () => {
    expect(creditFor(candidate({ artist: "A", licence: "CC BY-SA 3.0", credit: "Bundesarchiv" })))
      .toBe("A — “A Battle” — Bundesarchiv. CC BY-SA 3.0 via Wikimedia Commons.");
  });

  it("drops a credit field long enough to be provenance prose rather than a caption", () => {
    const wordy = "L'Histoire par l'image, digital version produced by the Agence photographique de la RMN";
    expect(creditFor(candidate({ credit: wordy }))).not.toContain("Agence");
  });

  it("still attributes an image with no artist or licence recorded", () => {
    expect(creditFor(candidate())).toBe("“A Battle”. via Wikimedia Commons.");
  });

  it("carries no link, so countSources cannot mistake a credit for a source", () => {
    expect(creditFor(candidate({ artist: "A", licence: "Public domain" }))).not.toContain("](");
  });
});

describe("imageIsReachable", () => {
  it("accepts a 200 that serves an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })));
    expect(await imageIsReachable("https://thumb.wikimedia.org/x.jpg")).toBe(true);
  });

  it("rejects a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      headers: new Headers({ "content-type": "image/jpeg" }),
    })));
    expect(await imageIsReachable("https://thumb.wikimedia.org/x.jpg")).toBe(false);
  });

  it("rejects a 200 that serves something other than an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
    })));
    expect(await imageIsReachable("https://thumb.wikimedia.org/x.jpg")).toBe(false);
  });

  it("rejects rather than throwing when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    expect(await imageIsReachable("https://thumb.wikimedia.org/x.jpg")).toBe(false);
  });
});
