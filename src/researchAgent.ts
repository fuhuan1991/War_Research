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
    if (state.research_iterations >= MAX_RESEARCHER_TURNS) {
      return new Command({ goto: "compression_node" });
    }

    const messages = state.researcher_messages;

    // Assess current situation
    const assessmentResponse: AIMessage = await fullModel.invoke([
      new SystemMessage(researcherAssessmentPrompt),
      ...messages,
    ]) as AIMessage;

    // Dispatch search task or stop searching
    const dispatchingResponse: AIMessage = await dispatchingModel.invoke([
      new SystemMessage(researcherDispatchingPrompt(MAX_RESEARCHER_TURNS, MAX_CONCURRENT_TAVILY_SEARCHES)),
      ...messages,
      assessmentResponse,
    ]) as AIMessage;

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

    const results = await Promise.all(
      allowedCalls.map((tc) => executeTavilySearch(tc.args.query as string))
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
      },
    });
  };

export const makeCompressionNode = () =>
  async (state: ResearcherStateType) => {
    const messages = state.researcher_messages;

    const response = await fullModel.invoke([
      new SystemMessage(researcherCompressionSystemPrompt),
      ...messages,
      new HumanMessage(researcherCompressionHumanMessage(state.research_topic)),
    ]) as AIMessage;

    const rawNotes = messages
      .filter((m: BaseMessage): m is ToolMessage => m._getType() === "tool")
      .map((m: ToolMessage) => m.content as string)
      // Synthetic control messages use the "<...>" convention; real search results never start with "<"
      .filter((content) => !content.startsWith("<"));

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
