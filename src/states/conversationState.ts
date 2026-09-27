import { z } from "zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { BaseMessage } from "@langchain/core/messages";
import { PlanSchema, PlanType } from "../plan.js";

/**
 * State for the top-level conversation graph: the scoping / plan-confirmation negotiation
 * followed by the research and report phases.
 *
 * NOTE: every non-message field below uses `withLangGraph(..., { default })` rather than
 * zod's `.default()`. LangGraph builds its channels from the registry metadata, so a plain
 * `z.number().default(0)` reads back as `undefined` inside a node — which would make
 * `state.confirm_rounds + 1` evaluate to NaN.
 */
export const ConversationState = z.object({
  messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),

  // ---------- scoping and plan negotiation ----------

  // Set by scope_topic once a workable topic is present.
  ready_to_plan: withLangGraph(z.boolean(), { default: () => false }),

  // The rough topic the user has agreed to. Stable anchor across plan revisions:
  // angle-level feedback leaves it alone, topic-level feedback clears it.
  rough_topic: withLangGraph(z.string(), { default: () => "" }),

  // The suggestive nudge written by scope_topic and surfaced by ask_user's interrupt.
  pending_question: withLangGraph(z.string(), { default: () => "" }),

  // Written by propose_plan BEFORE confirm_plan pauses — confirm_plan re-executes from
  // the top on resume and rebuilds its interrupt payload from state, so the plan cannot
  // live in a local variable. Also the sole input to the research phase: dispatch_research
  // renders it into supervisor_messages, and report_generator renders it into its prompt.
  plan: withLangGraph(PlanSchema.nullable(), { default: (): PlanType | null => null }),

  plan_confirmed: withLangGraph(z.boolean(), { default: () => false }),

  // Rejected-plan counter, checked against MAX_CONFIRM_ROUNDS in propose_plan.
  confirm_rounds: withLangGraph(z.number(), { default: () => 0 }),

  // Not-ready counter, checked against MAX_CLARIFY_ROUNDS in scope_topic.
  clarify_rounds: withLangGraph(z.number(), { default: () => 0 }),

  // ---------- research and report ----------

  supervisor_messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
  raw_notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  final_report: withLangGraph(z.string(), { default: () => "" }),
});

export type ConversationStateType = z.infer<typeof ConversationState>;
