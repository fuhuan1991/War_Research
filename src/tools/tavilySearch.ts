import { tavily } from "@tavily/core";
import { HumanMessage } from "@langchain/core/messages";
import { summarizeWebpagePrompt } from "../prompts/summarizeWebpagePrompt.js";
import { miniModel } from "../model.js";
import { TAVILY_MAX_RESULTS } from "../config.js";
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

// Summarizes raw page text via a cheap model call; falls back to a 1000-char
// truncation if the model call fails or returns malformed JSON.
async function summarizeWebpage(rawContent: string): Promise<string> {
  try {
    const response = await miniModel.invoke([
      new HumanMessage(summarizeWebpagePrompt(rawContent, getToday())),
    ]);

    const text = response.content as string;
    const parsed = JSON.parse(text.trim());
    return (
      `<summary>\n${parsed.summary}\n</summary>\n\n` +
      `<key_excerpts>\n${parsed.key_excerpts}\n</key_excerpts>`
    );
  } catch {
    return rawContent.length > 1000 ? rawContent.slice(0, 1000) + "..." : rawContent;
  }
}

// Runs summarization for all unique results in parallel.
async function processResults(
  uniqueResults: Map<string, SearchResult>
): Promise<Map<string, ProcessedResult>> {
  const processed = new Map<string, ProcessedResult>();

  await Promise.all(
    Array.from(uniqueResults.entries()).map(async ([url, result]) => {
      const content = result.rawContent
        ? await summarizeWebpage(result.rawContent)
        : result.content;
      processed.set(url, { title: result.title, content, domain: hostOf(url), score: result.score });
    })
  );

  return processed;
}

// Formats results into a numbered list of SOURCE blocks for the agent to read.
function formatOutput(processed: Map<string, ProcessedResult>): string {
  if (processed.size === 0) {
    return "No valid search results found. Please try different search queries or use a different search API.";
  }

  let output = "Search results:\n\n";
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
  return output;
}

// Searches the web via Tavily, deduplicates results, summarizes each page,
// and returns a formatted string ready for the researcher agent.
export async function executeTavilySearch(query: string): Promise<string> {
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

  const processed = await processResults(uniqueResults);
  return formatOutput(processed);
}
