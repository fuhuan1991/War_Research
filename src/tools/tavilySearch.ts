import { tavily } from "@tavily/core";
import { HumanMessage } from "@langchain/core/messages";
import { summarizeWebpagePrompt } from "../prompts/summarizeWebpagePrompt.js";
import { miniModel } from "../model.js";
import { TAVILY_MAX_RESULTS, MAX_RAW_CONTENT_CHARS } from "../config.js";
import { PREFERRED_DOMAINS } from "./preferredDomains.js";
import { DENIED_DOMAINS } from "./deniedDomains.js";

const tavilyClient = tavily();

function getToday(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;  // Tavily's own relevance score. 
}

interface ProcessedResult {
  title: string;
  content: string;
  domain: string;
  score?: number;
}

// The result's host without a leading "www.". Not a true registrable domain — that needs a
// public-suffix list — but enough for the assessment to recognise who is making a claim.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

// Deduplicates by URL.
function deduplicateResults(results: SearchResult[]): Map<string, SearchResult> {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    if (!unique.has(result.url)) {
      unique.set(result.url, result);
    }
  }
  return unique;
}

// Summarizes raw page text via a cheap model call; falls back to a 1000-char truncation if
// the model call fails or returns malformed JSON.
//
// `ok` reports whether the summary is real. Two things depend on knowing that:
//   1. The fallback is raw page text cut mid-sentence. Printed under `SUMMARY:` with nothing
//      marking it, it reads to the researcher as a summary of the whole page — observed on a
//      europeana.eu page that came through as 1,252 characters ending mid-word.
//   2. `processResults` must not record a failed page as summarised, or the run-level dedupe
//      locks the degraded version in and no later search can retry the page.
//
// The input is capped at MAX_RAW_CONTENT_CHARS first — see that constant for why. The cut
// keeps the head of the page, which is where a document's framing and opening sections sit;
// a source whose relevant material falls past the ceiling will summarise worse, and the
// <note> below is what tells the researcher that happened.
async function summarizeWebpage(rawContent: string): Promise<{ content: string; ok: boolean }> {
  const truncated = rawContent.length > MAX_RAW_CONTENT_CHARS;
  const input = truncated ? rawContent.slice(0, MAX_RAW_CONTENT_CHARS) : rawContent;

  try {
    const response = await miniModel.invoke([
      new HumanMessage(summarizeWebpagePrompt(input, getToday())),
    ]);

    const text = response.content as string;
    const parsed = JSON.parse(text.trim());
    return {
      content:
        `<summary>\n${parsed.summary}\n</summary>\n\n` +
        `<key_excerpts>\n${parsed.key_excerpts}\n</key_excerpts>` +
        (truncated
          ? `\n\n<note>Source page exceeded ${MAX_RAW_CONTENT_CHARS} characters; ` +
            `only the first ${MAX_RAW_CONTENT_CHARS} were summarised.</note>`
          : ""),
      ok: true,
    };
  } catch (err) {
    // console.warn rather than a thrown error: one unsummarisable page is not worth failing a
    // search over, but it is worth being able to find afterwards. cli.ts diverts warn to
    // cli.log, so this stays out of the chat transcript.
    console.warn(
      `summarizeWebpage failed, falling back to raw truncation: ${(err as Error).message}`,
    );

    const body = rawContent.length > 1000 ? rawContent.slice(0, 1000) + "..." : rawContent;
    return {
      content:
        `<note>Summarisation of this page failed. The text below is the first ` +
        `${Math.min(rawContent.length, 1000)} characters of the raw page, not a summary — ` +
        `treat it as a fragment and do not assume it represents the whole page.</note>\n\n` +
        body,
      ok: false,
    };
  }
}

// Runs summarization for all unique results in parallel, skipping any page this researcher run
// has already summarised and reporting those separately as `omitted`.
//
// `seen` is shared and mutated: `research_tool_node` hands the same Set to every parallel
// `executeTavilySearch` call of a turn. That sharing is what stops two searches in one turn
// from both summarising a page they both returned; seeding it from state is what stops a later
// turn from re-summarising an earlier turn's page.
//
// A URL is claimed SYNCHRONOUSLY, before the first `await` in the callback below. JS is
// single-threaded, so a claim made before yielding is visible to every other parallel call —
// but move the `seen.add` after the summarisation and both calls sail past the check, which
// restores the duplication with no visible symptom. The identity of the Set and this ordering
// are both covered by unit tests for that reason.
async function processResults(
  uniqueResults: Map<string, SearchResult>,
  seen: Set<string>,
): Promise<{ processed: Map<string, ProcessedResult>; omitted: Map<string, string> }> {
  const processed = new Map<string, ProcessedResult>();
  const omitted = new Map<string, string>();

  await Promise.all(
    Array.from(uniqueResults.entries()).map(async ([url, result]) => {
      if (seen.has(url)) {
        omitted.set(url, result.title);
        return;
      }
      seen.add(url);

      // No raw text to summarise — Tavily's own snippet is used as-is, so there is no model
      // call that could fail and the claim above stands.
      if (!result.rawContent) {
        processed.set(url, {
          title: result.title,
          content: result.content,
          domain: hostOf(url),
          score: result.score,
        });
        return;
      }

      const { content, ok } = await summarizeWebpage(result.rawContent);

      // Release the claim when summarisation failed, so a later search may retry the page
      // instead of being told the truncated fragment is already held. The fragment is still
      // returned for this search — it is better than nothing — it just is not recorded as the
      // run's copy of that page.
      if (!ok) seen.delete(url);

      processed.set(url, { title: result.title, content, domain: hostOf(url), score: result.score });
    })
  );

  return { processed, omitted };
}

// Formats results into a numbered list of SOURCE blocks for the agent to read, followed by a
// note naming any source withheld because an earlier search in this run already returned it.
//
// The withheld sources are named rather than merely counted so the researcher can tell which
// page is meant and find it in the earlier tool message, instead of reading the omission as a
// source it never received.
function formatOutput(
  processed: Map<string, ProcessedResult>,
  omitted: Map<string, string>,
): string {
  if (processed.size === 0 && omitted.size === 0) {
    return "No valid search results found. Please try different search queries or use a different search API.";
  }

  let output = "";

  if (processed.size === 0) {
    // Every result was a page already held. The "no valid results" message above would be
    // false here, and it steers the assessment toward rewording the query — the opposite of
    // what this outcome means. Saying so plainly is also the cheapest signal available that a
    // query is going in circles.
    output +=
      `This query returned ${omitted.size} result(s), every one of which an earlier search in ` +
      `this run had already retrieved. It produced no new sources — searching this angle again ` +
      `in the same words will not either.\n`;
  } else {
    output += "Search results:\n\n";
    let i = 1;
    for (const [url, result] of processed) {
      output += `\n\n--- SOURCE ${i}: ${result.title} ---\n`;
      output += `URL: ${url}\n`;
      output += `DOMAIN: ${result.domain}\n`;
      output += `RELEVANCE: ${typeof result.score === "number" ? result.score.toFixed(2) : "n/a"}\n\n`;
      output += `SUMMARY:\n${result.content}\n\n`;
      output += "-".repeat(80) + "\n";
      i++;
    }
  }

  if (omitted.size > 0) {
    output +=
      `\nALREADY RETRIEVED — ${omitted.size} result(s) withheld because an earlier search in ` +
      `this run already returned them. Their content is in those earlier search results and is ` +
      `not repeated here:\n`;
    for (const [url, title] of omitted) {
      output += `  - ${title}: ${url}\n`;
    }
  }

  return output;
}

// Searches the web via Tavily, deduplicates results, summarizes each page,
// and returns a formatted string ready for the researcher agent.
export async function executeTavilySearch(query: string, seen: Set<string>): Promise<string> {
  let response;
  try {
    response = await tavilyClient.search(query, {
      maxResults: TAVILY_MAX_RESULTS,
      includeRawContent: "text",
      // "prefer" is a soft boost, verified against the live API: off-list results still
      // come back, so this can never starve a query. Do not change it to "restrict" —
      // measured, a 1453 query restricted to the whole prefer list returns nothing but
      // Wikipedia and Britannica.
      includeDomains: PREFERRED_DOMAINS,
      includeDomainsMode: "prefer",
      excludeDomains: DENIED_DOMAINS,
    });
  } catch (err) {
    return `Search failed: ${(err as Error).message}. Please try a different query.`;
  }

  // An example item in resonse:
  // {
  //     title: '#Reviewing Tank Warfare on the Eastern Front 1941-1942',
  //     url: 'https://thestrategybridge.org/the-bridge/2019/11/6/reviewing-tank-warfare-on-the-eastern-front-1941-1942',
  //     content: '#Reviewing Tank Warfare on the Eastern Front 1941-1942...',
  //     rawContent: '...',
  //     score: 0.27004525,
  //     publishedDate: undefined,
  //     favicon: undefined
  //  }

  const uniqueResults = deduplicateResults(response.results);

  const { processed, omitted } = await processResults(uniqueResults, seen);
  return formatOutput(processed, omitted);
}
