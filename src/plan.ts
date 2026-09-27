import { z } from "zod";

/**
 * The research plan: the single artifact the pre-research phase produces.
 *
 * `final_topic` is the sharpened version of the negotiated `rough_topic`; `angles` are the
 * lines of inquiry the user explicitly approved. This replaces the old `research_brief`
 * string — a plan carries the same information in a form the user can critique angle by
 * angle, and `planToBrief` renders it back to prose wherever a string is needed.
 *
 * Lives in its own module rather than in the state schema so that both the conversation
 * graph and the supervisor can import it. `conversationAgent.ts` already imports
 * `supervisorAgent.ts`, so anything the supervisor needs cannot live in the former.
 */
export const PlanSchema = z.object({
  final_topic: z.string(),
  angles: z.array(z.string()),
});

export type PlanType = z.infer<typeof PlanSchema>;

// Asked at the end of every plan proposal. It is written into `messages` so that any UI
// rendering the message stream shows it, and reused as confirm_plan's interrupt payload —
// exactly the arrangement scope_topic/ask_user already use for `pending_question`.
export const CONFIRM_QUESTION =
  "Does this research plan look right? Approve it, or tell me what to change.";

export const formatAngles = (angles: string[]) =>
  angles.map((a, i) => `${i + 1}. ${a}`).join("\n");

export const formatPlan = (plan: PlanType) =>
  `**Proposed research plan**\n\n**Topic:** ${plan.final_topic}\n\n**Angles:**\n${formatAngles(plan.angles)}`;

export const formatPlanWithQuestion = (plan: PlanType) =>
  `${formatPlan(plan)}\n\n${CONFIRM_QUESTION}`;

/**
 * Renders the confirmed plan as the prose brief the research layers read.
 *
 * Two consumers, and they must agree: it seeds `supervisor_messages` (the supervisor reads
 * its goal out of that first human message, not out of any state field), and it fills the
 * `{research_plan}` slot in the report prompt.
 *
 * TODO: the supervisor is still free to derive its own sub-topics from this text, so the
 * angles the user approved are a strong suggestion rather than a guarantee. The planned fix
 * is to have the supervisor emit one ConductResearch call per angle on its first turn,
 * skipping that turn's LLM dispatch entirely — at which point this function's angle section
 * becomes context rather than instruction.
 */
export const planToBrief = (plan: PlanType) =>
  `Research topic:\n${plan.final_topic}\n\n` +
  `Research angles — each of these was proposed to the user and settled with them before ` +
  `research began, so all of them are expected to be covered:\n${formatAngles(plan.angles)}`;
