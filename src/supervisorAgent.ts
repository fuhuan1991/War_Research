import "dotenv/config";
import { StateGraph, START, END, Command } from "@langchain/langgraph";
import { SystemMessage, AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { SupervisorState, SupervisorStateType } from "./states/supervisorState.js";
import { fullModel, nanoModel } from "./model.js";
import { MAX_SUPERVISOR_TURNS, MAX_CONCURRENT_RESEARCH_UNITS } from "./config.js";
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

const dispatchingModel = nanoModel.bindTools([ConductResearch, CompleteResearch], { tool_choice: "required" });


// ============================================================ NODES ============================================================

export const makeSupervisorNode = () =>
  async (state: SupervisorStateType) => {
    const supervisorMessages = state.supervisor_messages;
    console.log("SupervisorNode: iteration " + state.research_iterations)

    // Assess current situation 
    const assessmentResponse: AIMessage = await fullModel.invoke([
      new SystemMessage(supervisorAssessmentPrompt),
      ...supervisorMessages,
    ]) as AIMessage;

    // Dispatch research task or stop research.
    //
    // Deliberately NOT given `...supervisorMessages`. This model only has to name a tool, and
    // the assessment above already states the decision and the sub-topics, so the history buys
    // it nothing while being charged for on every turn — and the tool messages in that history
    // are whole researcher reports. A traced run measured this call receiving 60,939 prompt
    // characters (14,163 input tokens) to emit 11 output tokens naming CompleteResearch, and
    // the cost grows with every note that comes back. The researcher's dispatch call was
    // changed for the same reason; see researchAgent.ts.
    //
    // The brief still goes in: it is one constant message rather than a growing one, and the
    // ConductResearch topics this model writes have to be self-contained, because a sub-agent
    // sees nothing but the topic it is handed. Located by type rather than by index [0] so
    // that a change to how dispatch_research seeds this graph degrades visibly here instead of
    // silently sending the wrong message.
    const brief = supervisorMessages.find((msg) => msg._getType() === "human");

    const decisionResponse: AIMessage = await dispatchingModel.invoke([
      new SystemMessage(
        supervisorDispatchingPrompt(
          MAX_SUPERVISOR_TURNS,
          MAX_CONCURRENT_RESEARCH_UNITS,
          // The counter still holds the pre-increment value here, so the turn being dispatched
          // is the next one.
          state.research_iterations + 1,
        ),
      ),
      ...(brief ? [brief] : []),
      assessmentResponse,
    ]) as AIMessage;

    console.log("SupervisorNode: assessment & decision completed");

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
    const iterationLimitReached = state.research_iterations > MAX_SUPERVISOR_TURNS;

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
          research_iterations: 0,
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
