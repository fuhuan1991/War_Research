import { tavily } from "@tavily/core";
import { HumanMessage } from "@langchain/core/messages";
import { summarizeWebpagePrompt } from "../prompts/summarizeWebpagePrompt.js";
import { miniModel } from "../model.js";
import { TAVILY_MAX_RESULTS } from "../config.js";

const tavilyClient = tavily();

function getToday(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
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
): Promise<Map<string, { title: string; content: string }>> {
  const processed = new Map<string, { title: string; content: string }>();

  await Promise.all(
    Array.from(uniqueResults.entries()).map(async ([url, result]) => {
      const content = result.rawContent
        ? await summarizeWebpage(result.rawContent)
        : result.content;
      processed.set(url, { title: result.title, content });
    })
  );

  return processed;
}

// Formats results into a numbered list of SOURCE blocks for the agent to read.
function formatOutput(processed: Map<string, { title: string; content: string }>): string {
  if (processed.size === 0) {
    return "No valid search results found. Please try different search queries or use a different search API.";
  }

  let output = "Search results:\n\n";
  let i = 1;
  for (const [url, result] of processed) {
    output += `\n\n--- SOURCE ${i}: ${result.title} ---\n`;
    output += `URL: ${url}\n\n`;
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

  console.log('--------ExecuteTavilySearch');
  console.log("Query: " + response.query);
  console.log("# of results: " + response.results.length);
  response.results.forEach(result => {
    console.log("-- " + result.title);
    console.log("score: " + result.score);
  });

  const uniqueResults = deduplicateResults(response.results);
  console.log("# of deduped results: " + uniqueResults.size);
  const processed = await processResults(uniqueResults);
  return formatOutput(processed);
}
