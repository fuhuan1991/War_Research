import { z } from "zod";
import { withLangGraph } from "@langchain/langgraph/zod";
import { ConversationState } from "./conversationState.js";

/**
 * The concrete research plan shown to the user for confirmation.
 * `final_topic` is the sharpened version of the negotiated `rough_topic`;
 * `angles` are the sub-questions that will eventually become one
 * ConductResearch call each (see MAX_CONCURRENT_RESEARCH_UNITS).
 */
export const PlanSchema = z.object({
  final_topic: z.string(),
  angles: z.array(z.string()),
});

export type PlanType = z.infer<typeof PlanSchema>;

/**
 * Experimental state for conversationAgentB — extends ConversationState with the
 * fields the scoping / plan-confirmation loop needs. Extending leaves the original
 * schema untouched while preserving the append reducers on messages/notes/raw_notes.
 *
 * NOTE: every field below uses `withLangGraph(..., { default })` rather than zod's
 * `.default()`. LangGraph builds its channels from the registry metadata, so a plain
 * `z.number().default(0)` reads back as `undefined` inside a node — which would make
 * `state.confirm_rounds + 1` evaluate to NaN.
 */
export const ConversationStateB = ConversationState.extend({
  // Set by scope_topic once a workable topic and a clear intent to start are both present.
  ready_to_plan: withLangGraph(z.boolean(), { default: () => false }),

  // The rough topic the user has agreed to. Stable anchor across plan revisions:
  // angle-level feedback leaves it alone, topic-level feedback clears it.
  rough_topic: withLangGraph(z.string(), { default: () => "" }),

  // The suggestive nudge written by scope_topic and surfaced by ask_user's interrupt.
  pending_question: withLangGraph(z.string(), { default: () => "" }),

  // Written by propose_plan BEFORE confirm_plan pauses — confirm_plan re-executes from
  // the top on resume and rebuilds its interrupt payload from state, so the plan cannot
  // live in a local variable.
  plan: withLangGraph(PlanSchema.nullable(), { default: (): PlanType | null => null }),

  plan_confirmed: withLangGraph(z.boolean(), { default: () => false }),

  // Rejected-plan counter, checked against MAX_CONFIRM_ROUNDS in propose_plan.
  confirm_rounds: withLangGraph(z.number(), { default: () => 0 }),

  // Not-ready counter, checked against MAX_CLARIFY_ROUNDS in scope_topic.
  clarify_rounds: withLangGraph(z.number(), { default: () => 0 }),
});

export type ConversationStateBType = z.infer<typeof ConversationStateB>;
