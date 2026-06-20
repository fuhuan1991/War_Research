import "dotenv/config";
import { StateGraph, START, END, Command } from "@langchain/langgraph";
import { SystemMessage, AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { SupervisorState, SupervisorStateType } from "./states/supervisorState.js";
import { model } from "./model.js";
import { supervisorAssessmentPrompt } from "./prompts/supervisorAssessmentPrompt.js";
import { supervisorDispatchingPrompt } from "./prompts/supervisorDispatchingPrompt.js";
import { researchAgent } from "./researchAgent.js";

// ============================================================ TOOLS ============================================================
// This tool is never actually executed by the supervisor node. Execution logic is in supervisorToolNode.
const ConductResearch = tool(
  async ({ researchTopic }: { researchTopic: string }) => researchTopic,
  {
    name: "ConductResearch",
    description: "Initiate research on a specific topic by a sub-agent.",
    schema: z.object({
      researchTopic: z.string().describe("The specific topic to research."),
    }),
  }
);

// This tool is never actually executed by the supervisor node. Execution logic is in supervisorToolNode.
const CompleteResearch = tool(
  async () => "done",
  {
    name: "CompleteResearch",
    description: "Signal that all necessary research has been completed.",
    schema: z.object({}),
  }
);

const dispatchingModel = model.bindTools([ConductResearch, CompleteResearch], { tool_choice: "required" });

// Maximum number of research iterations before forcing CompleteResearch
const max_supervisor_turns = 5;

// Maximum number of concurrent research agents the supervisor can launch
const max_concurrent_research_units = 3;

// ============================================================ NODES ============================================================

export const makeSupervisorNode = () =>
  async (state: SupervisorStateType) => {
    const supervisorMessages = state.supervisor_messages;

    // Assess current situation 
    const assessmentResponse: AIMessage = await model.invoke([
      new SystemMessage(supervisorAssessmentPrompt),
      ...supervisorMessages,
    ]) as AIMessage;

    // Dispatch research task or stop research
    const decisionResponse: AIMessage = await dispatchingModel.invoke([
      new SystemMessage(supervisorDispatchingPrompt(max_supervisor_turns, max_concurrent_research_units)),
      ...supervisorMessages,
      assessmentResponse,
    ]) as AIMessage;

    return new Command({
      goto: "supervisor_tool_node",
      update: {
        supervisor_messages: [assessmentResponse, decisionResponse],
        research_iterations: state.research_iterations + 1,
      },
    });
  };

const getNotesFromToolMessages = (messages: BaseMessage[]): string[] => {
  return messages
    .filter((msg) => msg._getType() === "tool")
    .map((msg) => msg.content as string);
};

export const makeSupervisorToolNode = () =>
  async (state: SupervisorStateType) => {
    const supervisorMessages = state.supervisor_messages;
    const lastMessage = supervisorMessages[supervisorMessages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls ?? [];

    const isComplete = toolCalls.some((tc) => tc.name === "CompleteResearch");
    const iterationLimitReached = state.research_iterations > max_supervisor_turns;

    if (isComplete || iterationLimitReached) {
      const toolMessages: ToolMessage[] = toolCalls.map((tc) =>
        new ToolMessage({
          content: tc.name === "CompleteResearch" ? "<Research completed>" : "<Research completed, skipping further research>",
          name: tc.name,
          tool_call_id: tc.id!,
        })
      );

      return new Command({
        goto: END,
        update: {
          supervisor_messages: toolMessages,
          notes: getNotesFromToolMessages(supervisorMessages),
        },
      });
    }

    const conductResearchCalls = toolCalls.filter((tc) => tc.name === "ConductResearch");

    const results = await Promise.all(
      conductResearchCalls.map((tc) =>
        researchAgent.invoke({ 
          research_topic: tc.args.researchTopic,
          researcher_messages: [ new HumanMessage(tc.args.researchTopic) ],
        })
      )
    );

    const toolMessages = results.map((result, i) => ({
      role: "tool" as const,
      content: result.compressed_research,
      tool_call_id: conductResearchCalls[i].id!,
    }));

    return new Command({
      goto: "supervisor_node",
      update: {
        supervisor_messages: toolMessages,
      },
    });
  };

const supervisorNode = makeSupervisorNode();
const supervisorToolNode = makeSupervisorToolNode();

// ============================================================ GRAPH ============================================================

const supervisorGraphBuilder = new StateGraph(SupervisorState)
  .addNode("supervisor_node", supervisorNode, { ends: ["supervisor_tool_node"] })
  .addNode("supervisor_tool_node", supervisorToolNode, { ends: ["supervisor_node", END] })
  .addEdge(START, "supervisor_node");

export const supervisorAgent = supervisorGraphBuilder.compile();
