import "dotenv/config";
import { StateGraph, START, END, Command, MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, getBufferString } from "@langchain/core/messages";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";

import { ConversationState } from "./states/conversationState.js";
import { clarificationPrompt, clarificationSystemPrompt } from "./prompts/clarificationPrompt.js";
import { briefingPrompt } from "./prompts/briefingPrompt.js";
import { supervisorAgent } from "./supervisorAgent.js";

export const model = new ChatOpenAI({
  model: "gpt-4.1",
  temperature: 0,
});

export const ClarificationOutput = z.object({
  related: z.boolean().describe(
    "True if the question is about a real battlefield war. False for unrelated questions or metaphorical uses of 'war' (trade war, culture war, cyber war, etc.)"
  ),
  need_clarification: z.boolean().describe(
    "True if the question is too vague or ambiguous to begin research. Always false when related is false."
  ),
  reject_reason: z.string().describe(
    "Explanation of why the question was rejected. Populate only when related is false. Empty string otherwise."
  ),
  question: z.string().describe(
    "The clarifying question to ask the user. Populate only when need_clarification is true. Empty string otherwise."
  ),
  verification: z.string().describe(
    "Brief acknowledgement that research will now begin. Populate only when related is true and need_clarification is false. Empty string otherwise."
  ),
});

export const ResearchBriefOutput = z.object({
  research_brief: z.string().describe(
    "A detailed, warfare-contextualized research question derived from the conversation."
  ),
});

export type ClarificationModel = {
  withStructuredOutput: (schema: typeof ClarificationOutput) => {
    invoke: (messages: (SystemMessage | HumanMessage)[]) => Promise<z.infer<typeof ClarificationOutput>>;
  };
};

export type BriefingModel = {
  withStructuredOutput: (schema: typeof ResearchBriefOutput) => {
    invoke: (messages: HumanMessage[]) => Promise<z.infer<typeof ResearchBriefOutput>>;
  };
};

export const makeClarificationNode = (llm: ClarificationModel) =>
  async (state: typeof ConversationState.State) => {

    const prompt = clarificationPrompt
      .replace("{messages}", getBufferString(state.messages))
      .replace("{date}", new Date().toDateString());

    const structuredModel = llm.withStructuredOutput(ClarificationOutput);
    const response = await structuredModel.invoke([
      new SystemMessage(clarificationSystemPrompt),
      new HumanMessage(prompt),
    ]);

    // Question is not war-related — reject and end
    if (!response.related) {
      return new Command({
        goto: END,
        update: { messages: [new AIMessage(response.reject_reason)] },
      });
    }

    // Question is valid but needs clarification — ask and end (wait for next user message)
    if (response.need_clarification) {
      return new Command({
        goto: END,
        update: { messages: [new AIMessage(response.question)] },
      });
    }

    // Question is valid and clear — proceed to briefing
    return new Command({
      goto: "briefing_node",
      update: { 
        messages: [new AIMessage(response.verification)]
      },
    });
};

export const makeBriefingNode = (llm: BriefingModel) =>
  async (state: typeof ConversationState.State) => {
    const prompt = briefingPrompt
      .replace("{messages}", getBufferString(state.messages))
      .replace("{date}", new Date().toDateString());

    const structuredModel = llm.withStructuredOutput(ResearchBriefOutput);
    const response = await structuredModel.invoke([new HumanMessage(prompt)]);

    return { 
      research_brief: response.research_brief, 
      supervisor_messages: [new HumanMessage(response.research_brief)], 
    };
};

export const makeReportGenerator = (llm: BriefingModel) =>
  async (state: typeof ConversationState.State) => {
    // TODO: implement reportGenerator logic
    return {};
};

const briefingNode = makeBriefingNode(model);
const clarificationNode = makeClarificationNode(model);
const reportGenerator = makeReportGenerator(model);

// TODO: Before deploying to production, replace MemorySaver with a persistent
// database-backed checkpointer (e.g. PostgreSQL or MongoDB) and add a cleanup
// mechanism to evict stale conversation states (e.g. TTL-based deletion).
// MemorySaver grows indefinitely and will cause memory exhaustion under load.
const checkpointer = new MemorySaver();

const conversationGraphBuilder = new StateGraph(ConversationState)
  .addNode("clarification_node", clarificationNode, { ends: ["briefing_node", END] })
  .addNode("briefing_node", briefingNode)
  .addNode("supervisor_agent", supervisorAgent)
  .addNode("report_generator", reportGenerator)
  .addEdge(START, "clarification_node")
  .addEdge("briefing_node", "supervisor_agent")
  .addEdge("supervisor_agent", "report_generator")
  .addEdge("report_generator", END)



export const conversationGraph = conversationGraphBuilder.compile({ checkpointer });
