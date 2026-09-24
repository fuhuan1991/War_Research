import "dotenv/config";
import { StateGraph, START, END, Command, MemorySaver, interrupt } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, getBufferString } from "@langchain/core/messages";
import { z } from "zod";

import { ConversationStateB, ConversationStateBType, PlanType } from "./states/conversationStateB.js";
import { scopeTopicPrompt, scopeTopicSystemPrompt } from "./prompts/scopeTopicPrompt.js";
import { proposePlanPrompt } from "./prompts/proposePlanPrompt.js";
import { classifyFeedbackPrompt } from "./prompts/classifyFeedbackPrompt.js";
import { fullModel, miniModel } from "./model.js";

// ============================================================ CONFIG ============================================================
// Kept local to this experimental graph rather than in config.ts, so the B experiment has
// no footprint outside its own files. Promote them to config.ts if this graph graduates.

// How many suggestive nudges the user gets before the graph gives up and ends.
const MAX_CLARIFY_ROUNDS = 3;

// How many plans the user may reject before the next one is auto-accepted.
const MAX_CONFIRM_ROUNDS = 2;

// ============================================================ SCHEMAS ============================================================

export const ScopeTopicOutput = z.object({
  status: z.enum(["ready", "needs_input", "off_topic"]).describe(
    "'ready' when there is a specific in-scope topic AND a clear signal to start. 'off_topic' when the subject is not a real armed conflict. 'needs_input' for anything else (too vague, too broad, or no signal to start)."
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
    "Between 3 and 5 distinct, non-overlapping lines of inquiry, each phrased as a specific question or investigative brief."
  ),
});

export const ClassifyFeedbackOutput = z.object({
  kind: z.enum(["approve", "angle", "topic"]).describe(
    "'approve' when the user is accepting the plan as proposed. 'angle' when the subject still stands and only the lines of inquiry need adjusting. 'topic' when the user is rejecting the subject itself."
  ),
  reason: z.string().describe("One sentence explaining the classification."),
});

// ============================================================ MODEL TYPES ============================================================
// Mirrors the dependency-injection style in conversationAgent.ts so tests can pass a fake.

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

// ============================================================ HELPERS ============================================================

// Asked at the end of every plan proposal. It is written into `messages` so that any UI
// rendering the message stream shows it, and reused as confirm_plan's interrupt payload —
// exactly the arrangement scope_topic/ask_user already use for `pending_question`.
const CONFIRM_QUESTION =
  "Does this research plan look right? Approve it, or tell me what to change.";

const formatAngles = (angles: string[]) =>
  angles.map((a, i) => `${i + 1}. ${a}`).join("\n");

const formatPlan = (plan: PlanType) =>
  `**Proposed research plan**\n\n**Topic:** ${plan.final_topic}\n\n**Angles:**\n${formatAngles(plan.angles)}`;

const formatPlanWithQuestion = (plan: PlanType) =>
  `${formatPlan(plan)}\n\n${CONFIRM_QUESTION}`;

// ============================================================ NODES ============================================================

/**
 * LLM node — no interrupt. Decides whether the conversation contains a workable topic and
 * a clear signal to start, reading the full message history rather than just the last turn.
 *
 * Appends the nudge to `messages` itself so that ask_user can stay purely an interrupt().
 */
export const makeScopeTopicNode = (llm: ScopeTopicModel) =>
  async (state: ConversationStateBType) => {
    const prompt = scopeTopicPrompt
      .replace("{messages}", getBufferString(state.messages))
      .replace("{date}", new Date().toDateString());

    const structuredModel = llm.withStructuredOutput(ScopeTopicOutput);
    const response = await structuredModel.invoke([
      new SystemMessage(scopeTopicSystemPrompt),
      new HumanMessage(prompt),
    ]);

    // Topic is workable and the user wants to start — go plan it.
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
export const askUserNode = async (_state: ConversationStateBType) => {
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
  async (state: ConversationStateBType) => {
    const prompt = proposePlanPrompt
      .replace("{topic}", state.rough_topic)
      .replace("{messages}", getBufferString(state.messages))
      .replace("{date}", new Date().toDateString());

    const structuredModel = llm.withStructuredOutput(ProposePlanOutput);
    const response = await structuredModel.invoke([new HumanMessage(prompt)]);

    const plan: PlanType = {
      final_topic: response.final_topic,
      angles: response.angles,
    };

    // Round cap reached — auto-accept this plan rather than asking again.
    if (state.confirm_rounds >= MAX_CONFIRM_ROUNDS) {
      return new Command({
        goto: "research",
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
export const confirmPlanNode = async (_state: ConversationStateBType) => {
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
  async (state: ConversationStateBType) => {
    const prompt = classifyFeedbackPrompt
      .replace("{messages}", getBufferString(state.messages))
      .replace("{date}", new Date().toDateString())
      .replace("{final_topic}", state.plan?.final_topic ?? "")
      .replace("{angles}", formatAngles(state.plan?.angles ?? []));

    const structuredModel = llm.withStructuredOutput(ClassifyFeedbackOutput);
    const response = await structuredModel.invoke([new HumanMessage(prompt)]);

    // The user is happy with the plan as proposed.
    if (response.kind === "approve") {
      return new Command({
        goto: "research",
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
 * PLACEHOLDER. The real research sub-agent is not wired up in this graph — this node only
 * reports what it would have been handed, so the scoping and confirmation loop can be
 * exercised on its own without spending API calls on Tavily or the supervisor subgraph.
 */
export const researchNode = async (state: ConversationStateBType) => {
  const finalTopic = state.plan?.final_topic ?? "(no plan)";
  const angles = state.plan?.angles ?? [];

  return {
    messages: [new AIMessage(
      `[dummy research node] No research was performed.\n\n` +
      `Would have researched: ${finalTopic}\n` +
      `Angles:\n${formatAngles(angles)}`
    )],
  };
};

// ============================================================ GRAPH ============================================================

const scopeTopicNode = makeScopeTopicNode(fullModel);
const proposePlanNode = makeProposePlanNode(fullModel);
const classifyFeedbackNode = makeClassifyFeedbackNode(miniModel);

// interrupt() requires a checkpointer — without one there is nothing to resume from.
const checkpointer = new MemorySaver();

const conversationGraphBuilderB = new StateGraph(ConversationStateB)
  .addNode("scope_topic", scopeTopicNode, { ends: ["ask_user", "propose_plan", END] })
  .addNode("ask_user", askUserNode)
  .addNode("propose_plan", proposePlanNode, { ends: ["confirm_plan", "research"] })
  .addNode("confirm_plan", confirmPlanNode)
  .addNode("classify_feedback", classifyFeedbackNode, { ends: ["propose_plan", "scope_topic", "research"] })
  .addNode("research", researchNode)
  .addEdge(START, "scope_topic")
  .addEdge("ask_user", "scope_topic")
  .addEdge("confirm_plan", "classify_feedback")
  .addEdge("research", END);

export const conversationGraphB = conversationGraphBuilderB.compile({ checkpointer });
