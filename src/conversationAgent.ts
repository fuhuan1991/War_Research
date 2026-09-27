import "dotenv/config";
import { StateGraph, START, END, Command, MemorySaver, interrupt } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, getBufferString } from "@langchain/core/messages";
import { z } from "zod";

import { ConversationState, ConversationStateType } from "./states/conversationState.js";
import {
  PlanType,
  CONFIRM_QUESTION,
  formatAngles,
  formatPlan,
  formatPlanWithQuestion,
  planToBrief,
} from "./plan.js";
import { fillTemplate } from "./prompts/fillTemplate.js";
import { scopeTopicPrompt, scopeTopicSystemPrompt } from "./prompts/scopeTopicPrompt.js";
import { proposePlanPrompt } from "./prompts/proposePlanPrompt.js";
import { classifyFeedbackPrompt } from "./prompts/classifyFeedbackPrompt.js";
import { reportGeneratorPrompt } from "./prompts/reportGeneratorPrompt.js";
import { supervisorAgent } from "./supervisorAgent.js";
import { fullModel, miniModel } from "./model.js";
import { MAX_CLARIFY_ROUNDS, MAX_CONFIRM_ROUNDS, MAX_ANGLES_PER_PLAN } from "./config.js";

// ============================================================ SCHEMAS ============================================================

export const ScopeTopicOutput = z.object({
  status: z.enum(["ready", "needs_input", "off_topic"]).describe(
    "'ready' when there is a specific, in-scope topic. 'off_topic' when the subject is not a real armed conflict. 'needs_input' when the topic is too vague or too broad, or the user has explicitly asked you to hold off."
  ),
  topic: z.string().describe(
    "Concise distillation of what the user wants researched, synthesized from the whole conversation. Populate only when status is 'ready'. Empty string otherwise."
  ),
  pending_question: z.string().describe(
    "A suggestive, easy-to-answer prompt proposing a concrete next step — not an open-ended question. Populate only when status is 'needs_input' or 'off_topic'. Empty string otherwise."
  ),
});

export const ProposePlanOutput = z.object({
  final_topic: z.string().describe(
    "A sharpened, unambiguous statement of what will be researched, bounded in time or geography where that is what makes it researchable."
  ),
  angles: z.array(z.string()).describe(
    `Between 1 and ${MAX_ANGLES_PER_PLAN} distinct, non-overlapping lines of inquiry, each phrased as a specific question or investigative brief. Use the full budget unless the topic genuinely does not support another distinct angle — include an angle only if it delivers something the others do not, but do not drop one merely to be concise.`
  ),
});

export const ClassifyFeedbackOutput = z.object({
  kind: z.enum(["approve", "angle", "topic"]).describe(
    "'approve' when the user is accepting the plan as proposed. 'angle' when the subject still stands and only the lines of inquiry need adjusting. 'topic' when the user is rejecting the subject itself."
  ),
  reason: z.string().describe("One sentence explaining the classification."),
});

// ============================================================ MODEL TYPES ============================================================
// Node factories take the model as a parameter so tests can inject a fake.

export type ScopeTopicModel = {
  withStructuredOutput: (schema: typeof ScopeTopicOutput) => {
    invoke: (messages: (SystemMessage | HumanMessage)[]) => Promise<z.infer<typeof ScopeTopicOutput>>;
  };
};

export type ProposePlanModel = {
  withStructuredOutput: (schema: typeof ProposePlanOutput) => {
    invoke: (messages: HumanMessage[]) => Promise<z.infer<typeof ProposePlanOutput>>;
  };
};

export type ClassifyFeedbackModel = {
  withStructuredOutput: (schema: typeof ClassifyFeedbackOutput) => {
    invoke: (messages: HumanMessage[]) => Promise<z.infer<typeof ClassifyFeedbackOutput>>;
  };
};

// ============================================================ NODES ============================================================

/**
 * LLM node — no interrupt. Decides whether the conversation contains a workable topic,
 * reading the full message history rather than just the last turn.
 *
 * It deliberately does NOT ask the user to confirm that they want research: a specific
 * in-scope topic is treated as a request to research it. confirm_plan is the consent gate,
 * and it is a better-informed one — it shows the plan first — so a second "shall I?" here
 * would only cost the user a round-trip and a clarify round.
 *
 * Appends the nudge to `messages` itself so that ask_user can stay purely an interrupt().
 */
export const makeScopeTopicNode = (llm: ScopeTopicModel) =>
  async (state: ConversationStateType) => {
    const prompt = fillTemplate(scopeTopicPrompt, {
      messages: getBufferString(state.messages),
      date: new Date().toDateString(),
    });

    const structuredModel = llm.withStructuredOutput(ScopeTopicOutput);
    const response = await structuredModel.invoke([
      new SystemMessage(scopeTopicSystemPrompt),
      new HumanMessage(prompt),
    ]);

    // Topic is workable — go plan it.
    if (response.status === "ready") {
      return new Command({
        goto: "propose_plan",
        update: { ready_to_plan: true, rough_topic: response.topic },
      });
    }

    // Not ready. Off-topic and needs-input share this path — the status only shapes the
    // wording of the nudge, not the routing — but the loop is bounded so that a user we
    // can never satisfy is not redirected forever.
    if (state.clarify_rounds >= MAX_CLARIFY_ROUNDS) {
      return new Command({
        goto: END,
        update: {
          ready_to_plan: false,
          messages: [new AIMessage(
            "We don't seem to be converging on something I can research. " +
            "Start a new conversation whenever you'd like to try a different angle."
          )],
        },
      });
    }

    return new Command({
      goto: "ask_user",
      update: {
        ready_to_plan: false,
        pending_question: response.pending_question,
        clarify_rounds: state.clarify_rounds + 1,
        messages: [new AIMessage(response.pending_question)],
      },
    });
  };

/**
 * Interrupt-only node. Pauses for the user's reply to `pending_question` and nothing else.
 * Re-executes from the top on resume, which is safe precisely because it holds no other logic.
 * Routes back to scope_topic via a plain edge.
 */
export const askUserNode = async (_state: ConversationStateType) => {
  const answer = interrupt<string, unknown>(_state.pending_question);

  return {
    messages: [new HumanMessage(String(answer))],
    pending_question: "",
  };
};

/**
 * LLM node — no interrupt. Turns the agreed topic into a concrete plan, and enforces the
 * confirmation round cap.
 *
 * The plan is written to state (and rendered into `messages`) BEFORE confirm_plan pauses:
 * confirm_plan re-executes from the top on every resume and so can hold nothing itself, and
 * classify_feedback needs to see the proposal in the history to interpret the reply.
 */
export const makeProposePlanNode = (llm: ProposePlanModel) =>
  async (state: ConversationStateType) => {
    const prompt = fillTemplate(proposePlanPrompt(MAX_ANGLES_PER_PLAN), {
      topic: state.rough_topic,
      messages: getBufferString(state.messages),
      date: new Date().toDateString(),
    });

    const structuredModel = llm.withStructuredOutput(ProposePlanOutput);
    const response = await structuredModel.invoke([new HumanMessage(prompt)]);

    const plan: PlanType = {
      final_topic: response.final_topic,
      // MAX_ANGLES_PER_PLAN is a ceiling, and this is the only place it is actually
      // enforced — the prompt and the schema both ask for it, but neither binds the model,
      // and each surplus angle would become another researcher downstream. Mirrors what
      // researchAgent already does for searches.
      //
      // Note the asymmetry: going OVER is capped here, but a plan with fewer angles is
      // passed through untouched, including when the user asked for fewer. Honouring a
      // smaller number is left to the prompt, since reading it out of free text needs an
      // LLM. If the model ignores the request the user simply rejects the plan, and the
      // replan sees the request again in `messages`.
      angles: response.angles.slice(0, MAX_ANGLES_PER_PLAN),
    };

    // Round cap reached — auto-accept this plan rather than asking again.
    if (state.confirm_rounds >= MAX_CONFIRM_ROUNDS) {
      return new Command({
        goto: "dispatch_research",
        update: {
          plan,
          plan_confirmed: true,
          messages: [new AIMessage(
            `${formatPlan(plan)}\n\n_We've been round this a few times, so I'll proceed with this plan._`
          )],
        },
      });
    }

    return new Command({
      goto: "confirm_plan",
      update: {
        plan,
        plan_confirmed: false,
        messages: [new AIMessage(formatPlanWithQuestion(plan))],
      },
    });
  };

/**
 * Interrupt-only node, and the exact counterpart of ask_user: it pauses for a free-text reply
 * and does nothing else. Re-executing from the top on resume is safe precisely because it
 * holds no other logic. Routes to classify_feedback via a plain edge.
 *
 * Deciding whether the reply was an approval or a critique needs an LLM, which cannot live in
 * an interrupting node — so classify_feedback owns that reading.
 */
export const confirmPlanNode = async (_state: ConversationStateType) => {
  const answer = interrupt<string, unknown>(CONFIRM_QUESTION);

  return {
    messages: [new HumanMessage(String(answer))],
  };
};

/**
 * LLM node — no interrupt. Reads the user's free-text reply to the proposed plan and decides
 * whether it approves the plan, asks for different angles, or rejects the topic itself. Split
 * into its own node rather than a conditional edge for the same reason scope_topic and
 * ask_user are split: every LLM call gets its own checkpoint boundary.
 */
export const makeClassifyFeedbackNode = (llm: ClassifyFeedbackModel) =>
  async (state: ConversationStateType) => {
    const prompt = fillTemplate(classifyFeedbackPrompt, {
      messages: getBufferString(state.messages),
      date: new Date().toDateString(),
      final_topic: state.plan?.final_topic ?? "",
      angles: formatAngles(state.plan?.angles ?? []),
    });

    const structuredModel = llm.withStructuredOutput(ClassifyFeedbackOutput);
    const response = await structuredModel.invoke([new HumanMessage(prompt)]);

    // The user is happy with the plan as proposed.
    if (response.kind === "approve") {
      return new Command({
        goto: "dispatch_research",
        update: { plan_confirmed: true },
      });
    }

    // The topic still stands — regenerate the plan. This is the only path that spends a
    // confirmation round, so approving costs nothing against MAX_CONFIRM_ROUNDS.
    if (response.kind === "angle") {
      return new Command({
        goto: "propose_plan",
        update: { confirm_rounds: state.confirm_rounds + 1 },
      });
    }

    // The topic itself is rejected — renegotiate it from scratch. Both counters reset, so a
    // genuinely new subject gets a fresh clarification and confirmation budget rather than
    // inheriting the exhausted one from the abandoned topic.
    return new Command({
      goto: "scope_topic",
      update: {
        ready_to_plan: false,
        rough_topic: "",
        plan: null,
        plan_confirmed: false,
        confirm_rounds: 0,
        clarify_rounds: 0,
      },
    });
  };

/**
 * Hands the confirmed plan to the supervisor subgraph. No LLM call — it only renders the
 * plan into the seed message the supervisor reads its goal from.
 *
 * Both routes into the research phase (an approval in classify_feedback, and the round-cap
 * auto-accept in propose_plan) pass through here rather than seeding supervisor_messages
 * themselves, so there is exactly one place to change when the supervisor is reworked to
 * dispatch one researcher per approved angle.
 */
export const dispatchResearchNode = async (state: ConversationStateType) => {
  if (!state.plan) {
    // Unreachable by construction: every edge into this node sets `plan` first.
    throw new Error("dispatch_research was reached without a confirmed plan");
  }

  return {
    supervisor_messages: [new HumanMessage(planToBrief(state.plan))],
  };
};

export const makeReportGenerator = (llm: { invoke: (messages: HumanMessage[]) => Promise<AIMessage> }) =>
  async (state: ConversationStateType) => {
    const findings = state.notes.join("\n");

    const prompt = fillTemplate(reportGeneratorPrompt, {
      research_plan: state.plan ? planToBrief(state.plan) : "",
      findings,
      date: new Date().toDateString(),
    });

    const response = await llm.invoke([new HumanMessage(prompt)]) as AIMessage;

    return {
      final_report: response.content as string,
      messages: [new AIMessage("Here is the final report:\n\n" + response.content)],
    };
  };

// ============================================================ GRAPH ============================================================

const scopeTopicNode = makeScopeTopicNode(fullModel);
const proposePlanNode = makeProposePlanNode(fullModel);
const classifyFeedbackNode = makeClassifyFeedbackNode(miniModel);
const reportGenerator = makeReportGenerator(fullModel);

// interrupt() requires a checkpointer — without one there is nothing to resume from.
//
// TODO: Before deploying to production, replace MemorySaver with a persistent
// database-backed checkpointer (e.g. PostgreSQL or MongoDB) and add a cleanup
// mechanism to evict stale conversation states (e.g. TTL-based deletion).
// MemorySaver grows indefinitely and will cause memory exhaustion under load.
const checkpointer = new MemorySaver();

const conversationGraphBuilder = new StateGraph(ConversationState)
  .addNode("scope_topic", scopeTopicNode, { ends: ["ask_user", "propose_plan", END] })
  .addNode("ask_user", askUserNode)
  .addNode("propose_plan", proposePlanNode, { ends: ["confirm_plan", "dispatch_research"] })
  .addNode("confirm_plan", confirmPlanNode)
  .addNode("classify_feedback", classifyFeedbackNode, { ends: ["propose_plan", "scope_topic", "dispatch_research"] })
  .addNode("dispatch_research", dispatchResearchNode)
  .addNode("supervisor_agent", supervisorAgent)
  .addNode("report_generator", reportGenerator)
  .addEdge(START, "scope_topic")
  .addEdge("ask_user", "scope_topic")
  .addEdge("confirm_plan", "classify_feedback")
  .addEdge("dispatch_research", "supervisor_agent")
  .addEdge("supervisor_agent", "report_generator")
  .addEdge("report_generator", END);

export const conversationGraph = conversationGraphBuilder.compile({ checkpointer });
