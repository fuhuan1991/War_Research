import { StateGraph, START, END, Command } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { ResearcherState, ResearcherStateType } from "./states/researcherState.js";
import { fullModel, nanoModel } from "./model.js";
import { MAX_RESEARCHER_TURNS, MAX_CONCURRENT_TAVILY_SEARCHES } from "./config.js";
import { executeTavilySearch } from "./tools/tavilySearch.js";
import { researcherAssessmentPrompt } from "./prompts/researcherAssessmentPrompt.js";
import { researcherDispatchingPrompt } from "./prompts/researcherDispatchingPrompt.js";
import { researcherCompressionSystemPrompt, researcherCompressionHumanMessage } from "./prompts/researcherCompressionPrompt.js";
import { fillTemplate } from "./prompts/fillTemplate.js";

// ============================================================ TOOLS ============================================================

const TavilySearch = tool(
  async ({ query }: { query: string }) => "done",
  {
    name: "TavilySearch",
    description: "Search the web for information on a given query.",
    schema: z.object({
      query: z.string().describe("The search query."),
    }),
  }
);

// Signals the LLM is done searching and research should be compressed
const CompleteSearch = tool(
  async () => "done",
  {
    name: "CompleteSearch",
    description: "Signal that sufficient information has been gathered and research is complete.",
    schema: z.object({}),
  }
);


const dispatchingModel = nanoModel.bindTools([TavilySearch, CompleteSearch], { tool_choice: "required" });

// ============================================================ NODES ============================================================

export const makeResearchNode = () =>
  async (state: ResearcherStateType) => {

    const researchTopic = state.research_topic?.trim();
    if (!researchTopic) {
      throw new Error("researchAgent invoked without a research_topic");
    }

    if (state.research_iterations >= MAX_RESEARCHER_TURNS) {
      return new Command({ goto: "compression_node" });
    }

    const messages = state.researcher_messages;

    console.log("ResearchNode: iteration " + state.research_iterations)

    // Assess current situation
    const assessmentResponse: AIMessage = await fullModel.invoke([
      new SystemMessage(fillTemplate(researcherAssessmentPrompt, { topic: researchTopic })),
      ...messages,
    ]) as AIMessage;

    // Dispatch search task or stop searching.
    // Deliberately NOT given `...messages`. This model only has to name a tool, and the
    // assessment above already states the decision and the next query, so the history buys
    // it nothing while being charged for on every turn.
    const dispatchingResponse: AIMessage = await dispatchingModel.invoke([
      new SystemMessage(
        fillTemplate(
          researcherDispatchingPrompt(MAX_RESEARCHER_TURNS, MAX_CONCURRENT_TAVILY_SEARCHES),
          { topic: researchTopic },
        ),
      ),
      new HumanMessage(researchTopic),
      assessmentResponse,
    ]) as AIMessage;

    console.log("ResearchNode: assessment & decision completed");

    return new Command({
      goto: "research_tool_node",
      update: {
        researcher_messages: [assessmentResponse, dispatchingResponse],
        research_iterations: state.research_iterations + 1,
      },
    });
  };

export const makeResearchToolNode = () =>
  async (state: ResearcherStateType) => {
    const messages = state.researcher_messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls ?? [];

    const isComplete = toolCalls.some((tc) => tc.name === "CompleteSearch");

    // End a search task
    if (isComplete) {
      const toolMessages: ToolMessage[] = toolCalls.map((tc) =>
        new ToolMessage({
          content: "<Research completed>",
          name: tc.name,
          tool_call_id: tc.id!,
        })
      );

      return new Command({
        goto: "compression_node",
        update: {
          researcher_messages: toolMessages,
        },
      });
    }

    // Dispatch new search task throuth TavilySearch tool
    const searchCalls = toolCalls.filter((tc) => tc.name === "TavilySearch");
    const allowedCalls = searchCalls.slice(0, MAX_CONCURRENT_TAVILY_SEARCHES);
    const skippedCalls = searchCalls.slice(MAX_CONCURRENT_TAVILY_SEARCHES);

    // One Set for the whole turn, seeded with every URL earlier turns already summarised.
    // Passing the same instance to all of this turn's parallel searches is what stops two of
    // them from both summarising a page they both returned; the seed is what stops this turn
    // from re-summarising an earlier turn's page. `prior` is kept to diff against, because
    // seen_urls appends and must receive only what is new.
    const prior = new Set(state.seen_urls);
    const seen = new Set(prior);

    const results = await Promise.all(
      allowedCalls.map((tc) => executeTavilySearch(tc.args.query as string, seen))
    );

    const toolMessages: ToolMessage[] = [
      ...results.map((result, i) =>
        new ToolMessage({
          content: String(result),
          name: allowedCalls[i].name,
          tool_call_id: allowedCalls[i].id!,
        })
      ),
      ...skippedCalls.map((tc) =>
        new ToolMessage({
          content: "<Search skipped: concurrent search limit reached>",
          name: tc.name,
          tool_call_id: tc.id!,
        })
      ),
    ];

    return new Command({
      goto: "research_node",
      update: {
        researcher_messages: toolMessages,
        // Only what this turn added: the channel's reducer appends, so writing the whole union
        // would re-add every earlier URL and grow the array quadratically.
        seen_urls: [...seen].filter((url) => !prior.has(url)),
      },
    });
  };

/**
 * Pairs every TavilySearch tool_call_id with the query it carried, so each block of results
 * can be labelled with the search that produced it. Built over the whole message list rather
 * than the last turn's, because a run's results span several dispatch messages.
 */
const queriesById = (messages: BaseMessage[]): Map<string, string> => {
  const byId = new Map<string, string>();

  for (const message of messages) {
    if (message._getType() !== "ai") continue;
    for (const call of (message as AIMessage).tool_calls ?? []) {
      if (call.name !== "TavilySearch" || !call.id) continue;
      byId.set(call.id, String((call.args as { query?: unknown }).query ?? ""));
    }
  }

  return byId;
};

export const makeCompressionNode = () =>
  async (state: ResearcherStateType) => {
    const messages = state.researcher_messages;

    const searchResults = messages
      .filter((m: BaseMessage): m is ToolMessage => m._getType() === "tool")
      // Synthetic control messages use the "<...>" convention; real search results never start with "<"
      .filter((m: ToolMessage) => !(m.content as string).startsWith("<"));

    const rawNotes = searchResults.map((m) => m.content as string);

    // The model is handed the search results as one rendered block rather than the message list
    const byId = queriesById(messages);
    const searchRecord = searchResults.length
      ? searchResults
          .map((m, i) => {
            const query = byId.get(m.tool_call_id) ?? "(query not recorded)";
            return `--- SEARCH ${i + 1} — query: ${query} ---\n\n${m.content as string}`;
          })
          .join("\n\n")
      : "(No search results were gathered on this topic.)";

    const response = await fullModel.invoke([
      new SystemMessage(researcherCompressionSystemPrompt),
      new HumanMessage(researcherCompressionHumanMessage(state.research_topic, searchRecord)),
    ]) as AIMessage;

    return {
      compressed_research: response.content as string,
      raw_notes: rawNotes,
    };
  };

const researchNode = makeResearchNode();
const researchToolNode = makeResearchToolNode();
const compressionNode = makeCompressionNode();

// ============================================================ GRAPH ============================================================

  //        START
  //          │
  //          ▼
  //  ┌───────────────┐
  //  │ research_node │◄──────┐
  //  └───────────────┘       │
  //          │               │
  //          ▼               │
  // ┌─────────────────┐      │
  // │ research_tool_  │      │
  // │     node        │──────┘
  // └─────────────────┘   
  //          │
  //          │ 
  //          ▼
  // ┌─────────────────┐
  // │ compression_node│
  // └─────────────────┘
  //          │
  //          ▼
  //         END

const researcherGraphBuilder = new StateGraph(ResearcherState)
  .addNode("research_node", researchNode, { ends: ["research_tool_node", "compression_node"] })
  .addNode("research_tool_node", researchToolNode, { ends: ["research_node", "compression_node"] })
  .addNode("compression_node", compressionNode)
  .addEdge(START, "research_node")
  .addEdge("compression_node", END);

export const researchAgent = researcherGraphBuilder.compile();
