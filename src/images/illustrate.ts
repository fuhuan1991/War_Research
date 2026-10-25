/**
 * The illustration pass: turns a finished report into an illustrated one.
 *
 * Runs at the end of `report_generator`, AFTER the report text exists, which is what lets it
 * key off the report's real `##` headings instead of guessing how the generator chose to
 * structure its sections. It costs two `miniModel` calls and a handful of Commons requests —
 * roughly 15-25 seconds of wall clock after a research run that took minutes.
 *
 * Two LLM calls, not one, and the reason is structural rather than a cost trade: a single call
 * cannot both invent the search queries and choose among results it has not seen yet.
 *
 *   Call A (imageQueryPrompt) — report headings + the research findings → 2-4 word queries.
 *     Seeing the findings is the point: a section asking "what was the secret weapon at X"
 *     can only be illustrated once the findings have revealed what the weapon actually was.
 *   Call B (imagePickPrompt) — the fetched candidates → chosen candidate NUMBERS plus alt text.
 *     Needed because Commons' relevance ranking is literal; see imagePickPrompt's header for
 *     the bird-in-a-gun-barrel that this call exists to reject.
 *
 * Both calls cover every section at once rather than one call per section, so that the picking
 * model can see the whole report and avoid giving two sections the same painting.
 *
 * INVARIANT: no model ever supplies a URL. Call B returns an index into a catalogue this
 * module fetched, and every index is checked against what that section was actually offered.
 * A model asked for a URL will produce a plausible one, and a plausible-but-wrong image URL
 * is a broken image in a report that cost real money to produce.
 *
 * INVARIANT: illustration is best-effort and cannot fail a run. Every failure path — no
 * sections, no queries, a Commons outage, a malformed model response, an unreachable image —
 * returns the report unchanged.
 */

import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import {
  IMAGE_CANDIDATES_PER_QUERY,
  MAX_IMAGES_PER_SECTION,
  MAX_IMAGE_QUERIES_PER_REPORT,
} from "../config.js";
import { miniModel } from "../model.js";
import { fillTemplate } from "../prompts/fillTemplate.js";
import { imagePickPrompt } from "../prompts/imagePickPrompt.js";
import { imageQueryPrompt } from "../prompts/imageQueryPrompt.js";
import {
  type ImageCandidate,
  type ImageSearchFn,
  creditFor,
  imageIsReachable,
  searchWithBackoff,
} from "./commonsImages.js";
import { type ImageRef, insertImages, reportSections } from "./insertImages.js";

// ============================================================ SCHEMAS ============================================================

export const ImageQueryOutput = z.object({
  sections: z.array(
    z.object({
      index: z.number().describe("The section number, exactly as it was given to you."),
      queries: z
        .array(z.string())
        .describe(
          "Wikimedia Commons queries of 2 to 4 words each. Empty when the section cannot be illustrated."
        ),
    })
  ),
});

export const ImagePickOutput = z.object({
  sections: z.array(
    z.object({
      index: z.number().describe("The section number, exactly as it was given to you."),
      picks: z
        .array(
          z.object({
            candidate: z.number().describe("The number of the chosen candidate image."),
            alt: z
              .string()
              .describe("Under 15 words, plainly describing what the picture shows."),
          })
        )
        .describe("Chosen images, in the order they should appear. Empty when nothing fits."),
    })
  ),
});

/**
 * The two structured calls this module makes, as an overloaded signature.
 *
 * Narrow structural type rather than `ChatOpenAI` for the same reason the conversation
 * nodes use one: a test injects a plain object and needs no `vi.mock`.
 */
export type IllustrateModel = {
  withStructuredOutput: {
    (schema: typeof ImageQueryOutput): {
      invoke: (messages: HumanMessage[]) => Promise<z.infer<typeof ImageQueryOutput>>;
    };
    (schema: typeof ImagePickOutput): {
      invoke: (messages: HumanMessage[]) => Promise<z.infer<typeof ImagePickOutput>>;
    };
  };
};

export type IllustrateDeps = {
  llm?: IllustrateModel;
  search?: ImageSearchFn;
  reachable?: (url: string) => Promise<boolean>;
};

// ============================================================ PROMPT RENDERING ============================================================

const formatSections = (sections: { index: number; heading: string }[]): string =>
  sections.map(({ index, heading }) => `[${index}] ${heading}`).join("\n");

/** `(1024x768) — François Gérard`, with whichever provenance field exists. */
const describeCandidate = (candidate: ImageCandidate): string => {
  const by = candidate.artist ?? candidate.credit;
  return `(${candidate.width}x${candidate.height})${by ? ` — ${by}` : ""}`;
};

const formatCandidates = (
  sections: { index: number; heading: string }[],
  perSection: Map<number, number[]>,
  byNumber: Map<number, ImageCandidate>
): string =>
  sections
    .map(({ index, heading }) => {
      const numbers = perSection.get(index) ?? [];
      const lines = numbers.length
        ? numbers
            .map((number) => {
              const candidate = byNumber.get(number)!;
              return `  [${number}] ${candidate.title} ${describeCandidate(candidate)}`;
            })
            .join("\n")
        : "  (no images were found for this section)";
      return `SECTION [${index}] — ${heading}\n${lines}`;
    })
    .join("\n\n");

// ============================================================ THE PASS ============================================================

/**
 * Builds the candidate catalogue.
 *
 * One global numbering across the whole report, with a Commons file that several sections'
 * searches returned sharing a single number. That is what makes "never use the same image
 * twice" expressible to the model and enforceable afterwards.
 */
const buildCatalogue = (fetched: { index: number; candidates: ImageCandidate[] }[]) => {
  const byId = new Map<string, number>();
  const byNumber = new Map<number, ImageCandidate>();
  const perSection = new Map<number, number[]>();
  let next = 1;

  for (const { index, candidates } of fetched) {
    const numbers = perSection.get(index) ?? [];
    for (const candidate of candidates) {
      let number = byId.get(candidate.id);
      if (number === undefined) {
        number = next;
        next += 1;
        byId.set(candidate.id, number);
        byNumber.set(number, candidate);
      }
      if (!numbers.includes(number)) numbers.push(number);
    }
    perSection.set(index, numbers);
  }

  return { byNumber, perSection };
};

/**
 * Turns the picking model's answer into placeable refs, discarding anything it should not
 * have said: a section it was not given, a candidate number out of range, a candidate that
 * section was never offered, an image already placed in another section, or more than the
 * per-section cap.
 */
const resolvePicks = (
  picked: z.infer<typeof ImagePickOutput>,
  perSection: Map<number, number[]>,
  byNumber: Map<number, ImageCandidate>
): Map<number, ImageRef[]> => {
  const used = new Set<number>();
  const byIndex = new Map<number, ImageRef[]>();

  for (const section of picked.sections ?? []) {
    const offered = perSection.get(section.index);
    if (!offered) continue;

    const refs: ImageRef[] = [];
    for (const pick of (section.picks ?? []).slice(0, MAX_IMAGES_PER_SECTION)) {
      const candidate = byNumber.get(pick.candidate);
      if (!candidate) continue;
      if (!offered.includes(pick.candidate)) continue;
      if (used.has(pick.candidate)) continue;

      used.add(pick.candidate);
      refs.push({
        url: candidate.url,
        alt: pick.alt?.trim() || candidate.title,
        credit: creditFor(candidate),
      });
    }

    if (refs.length) byIndex.set(section.index, refs);
  }

  return byIndex;
};

/** Drops any image whose URL does not actually serve one. All checks run concurrently. */
const dropUnreachable = async (
  byIndex: Map<number, ImageRef[]>,
  reachable: (url: string) => Promise<boolean>
): Promise<Map<number, ImageRef[]>> => {
  const entries = [...byIndex.entries()];
  const checks = await Promise.all(
    entries.map(([, refs]) => Promise.all(refs.map((ref) => reachable(ref.url))))
  );

  const validated = new Map<number, ImageRef[]>();
  entries.forEach(([index, refs], position) => {
    const kept = refs.filter((_ref, slot) => checks[position][slot]);
    if (kept.length) validated.set(index, kept);
  });

  return validated;
};

/**
 * Illustrates a report. Returns the report unchanged on any failure, by contract.
 */
export const illustrateReport = async (
  report: string,
  notes: string[],
  deps: IllustrateDeps = {}
): Promise<string> => {
  const llm = deps.llm ?? (miniModel as unknown as IllustrateModel);
  const search = deps.search ?? searchWithBackoff;
  const reachable = deps.reachable ?? imageIsReachable;

  try {
    const sections = reportSections(report)
      .filter((section) => section.illustratable)
      .map(({ index, heading }) => ({ index, heading }));

    if (!sections.length) {
      console.log("Illustration: the report has no illustratable sections");
      return report;
    }

    // --- Call A: what to search for, grounded in the findings ---
    const queryResponse = await llm.withStructuredOutput(ImageQueryOutput).invoke([
      new HumanMessage(
        fillTemplate(imageQueryPrompt, {
          sections: formatSections(sections),
          findings: notes.join("\n"),
          max_queries: String(MAX_IMAGES_PER_SECTION),
          date: new Date().toDateString(),
        })
      ),
    ]);

    const known = new Set(sections.map((section) => section.index));
    const requests = (queryResponse.sections ?? [])
      .filter((section) => known.has(section.index))
      .flatMap((section) =>
        (section.queries ?? [])
          .map((query) => query.trim())
          .filter(Boolean)
          .map((query) => ({ index: section.index, query }))
      )
      .slice(0, MAX_IMAGE_QUERIES_PER_REPORT);

    if (!requests.length) {
      console.log("Illustration: no image queries were produced");
      return report;
    }

    // --- Fetch candidates. Requests are throttled inside the Commons client. ---
    const results = await Promise.all(
      requests.map(async ({ index, query }) => {
        console.log('Searching image for: ' + query);
        return {
          index,
          candidates: await search(query, IMAGE_CANDIDATES_PER_QUERY),
        }
      })
    );

    const { byNumber, perSection } = buildCatalogue(results);
    if (!byNumber.size) {
      console.log(`Illustration: ${requests.length} quer(ies) returned no usable images`);
      return report;
    }

    // --- Call B: which of them to use ---
    const pickResponse = await llm.withStructuredOutput(ImagePickOutput).invoke([
      new HumanMessage(
        fillTemplate(imagePickPrompt, {
          candidates: formatCandidates(sections, perSection, byNumber),
          max_per_section: String(MAX_IMAGES_PER_SECTION),
        })
      ),
    ]);

    const chosen = await dropUnreachable(resolvePicks(pickResponse, perSection, byNumber), reachable);
    const placed = [...chosen.values()].reduce((total, refs) => total + refs.length, 0);

    if (!placed) {
      console.log("Illustration: no candidate survived selection");
      return report;
    }

    console.log(`Illustration: placed ${placed} image(s) across ${chosen.size} section(s)`);
    return insertImages(report, chosen);
  } catch (err) {
    // By contract: a report that cost a full research run is never lost to its decorations.
    console.warn(`Illustration failed, returning the report unillustrated: ${(err as Error).message}`);
    return report;
  }
};
