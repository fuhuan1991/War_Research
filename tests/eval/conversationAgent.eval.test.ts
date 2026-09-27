import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { StateGraph, START, END, Command, MemorySaver } from "@langchain/langgraph";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";

import { ConversationState, ConversationStateType } from "../../src/states/conversationState.js";
import {
  makeScopeTopicNode,
  askUserNode,
  makeProposePlanNode,
  confirmPlanNode,
  makeClassifyFeedbackNode,
  dispatchResearchNode,
} from "../../src/conversationAgent.js";
import { CONFIRM_QUESTION, planToBrief, PlanType } from "../../src/plan.js";
import { fullModel, miniModel } from "../../src/model.js";
import { ANGLES_PER_PLAN } from "../../src/config.js";

// =============================================================================
// THE TEST GRAPH
// =============================================================================
//
// !! THIS GRAPH MUST MIRROR `conversationGraph` IN src/conversationAgent.ts !!
//
// It is a hand-assembled copy of the production wiring with exactly ONE
// difference: `dispatch_research` routes to END instead of to
// `supervisor_agent` -> `report_generator`. That keeps the eval confined to the
// pre-research half of the pipeline, so approving a plan here costs a handful
// of cheap LLM calls instead of spawning N researchers and their Tavily
// searches.
//
// Every node below is the REAL exported node, given the REAL model it gets in
// production (fullModel for scope_topic/propose_plan, miniModel for
// classify_feedback). Nothing about the node bodies, prompts, model tiers or
// routing decisions is faked -- only the edge out of the dispatch seam.
//
// There is no automated guard against these two graphs drifting apart.
// If you add, remove, rename or re-route a node in src/conversationAgent.ts,
// you MUST make the same change here, or this eval silently stops testing the
// thing it claims to test.
//
// `dispatch_research` is the right place to cut: it makes no LLM call, and its
// entire job is rendering the confirmed `plan` into `supervisor_messages`. So
// asserting on its output IS asserting that the handoff to research is correct,
// without paying for the research itself.
// =============================================================================

const buildPreResearchGraph = () =>
  new StateGraph(ConversationState)
    .addNode("scope_topic", makeScopeTopicNode(fullModel), { ends: ["ask_user", "propose_plan", END] })
    .addNode("ask_user", askUserNode)
    .addNode("propose_plan", makeProposePlanNode(fullModel), { ends: ["confirm_plan", "dispatch_research"] })
    .addNode("confirm_plan", confirmPlanNode)
    .addNode("classify_feedback", makeClassifyFeedbackNode(miniModel), {
      ends: ["propose_plan", "scope_topic", "dispatch_research"],
    })
    .addNode("dispatch_research", dispatchResearchNode)
    .addEdge(START, "scope_topic")
    .addEdge("ask_user", "scope_topic")
    .addEdge("confirm_plan", "classify_feedback")
    .addEdge("dispatch_research", END) // production: -> "supervisor_agent"
    .compile({ checkpointer: new MemorySaver() });

// =============================================================================
// HELPERS
// =============================================================================

type Step = {
  /** Nodes pending after this turn. `[]` means the graph ran to completion. */
  next: string[];
  values: ConversationStateType;
  /** Payload the paused node passed to interrupt(), if any. */
  interruptValue: string | undefined;
};

// -----------------------------------------------------------------------------
// Transcript logging
//
// Every log below is unconditional -- there is no verbosity flag -- because
// vitest already gates it exactly the way an eval wants. The default reporter
// HIDES console output from passing tests and PRINTS it, labelled with the
// suite and test name, the moment one fails. So a green run stays quiet, and a
// red run hands you the whole conversation that produced the failure. That
// matters more here than in a unit test: the transcript costs real API calls to
// regenerate, so it must never be lost behind a flag someone forgot to set.
//
// Pass `--reporter=verbose` to see the transcript on a green run too, when you
// want to eyeball the agent's wording rather than just its correctness.
// -----------------------------------------------------------------------------

const roleOf = (m: BaseMessage) => (m.getType() === "human" ? "human" : "ai   ");

/** Prints messages appended since the previous turn, one labelled line each. */
const logNewMessages = (messages: BaseMessage[], from: number) => {
  for (const m of messages.slice(from)) {
    console.log(`  ${roleOf(m)} | ${(m.content as string).replace(/\n/g, "\n        | ")}`);
  }
};

const logPlan = (plan: PlanType) => {
  console.log(`  plan   | topic: ${plan.final_topic}`);
  plan.angles.forEach((a, i) => console.log(`         |   ${i + 1}. ${a}`));
};

/**
 * Runs the graph until it interrupts or finishes, then snapshots it and prints
 * the turn.
 *
 * Reads the pause out of getState() rather than off the `__interrupt__` key of
 * invoke()'s return value: `next` and `tasks[].interrupts` are the stable way
 * to ask both "where did it stop?" and "what did it ask?".
 *
 * The counters go into the log alongside the messages because they are the
 * subject of half the assertions and are invisible in the message stream.
 */
async function runStep(
  graph: ReturnType<typeof buildPreResearchGraph>,
  config: { configurable: { thread_id: string } },
  label: string,
  input: unknown,
): Promise<Step> {
  // Snapshot before the turn so we can print only what this turn added. On a
  // fresh thread there is no checkpoint yet, hence the guards.
  const before = (await graph.getState(config)).values as ConversationStateType | undefined;
  const seen = before?.messages?.length ?? 0;
  const planBefore = JSON.stringify(before?.plan ?? null);

  await graph.invoke(input as never, config);
  const snapshot = await graph.getState(config);

  const step: Step = {
    next: [...snapshot.next],
    values: snapshot.values as ConversationStateType,
    interruptValue: snapshot.tasks[0]?.interrupts?.[0]?.value as string | undefined,
  };

  console.log(`\n--- ${label} ---`);
  logNewMessages(step.values.messages, seen);
  // Identity would always differ (getState deserializes fresh), so compare by value.
  if (step.values.plan && JSON.stringify(step.values.plan) !== planBefore) {
    logPlan(step.values.plan);
  }
  console.log(
    `  state  | paused at: ${step.next.length ? step.next.join(", ") : "<END>"}` +
      `   clarify_rounds=${step.values.clarify_rounds}` +
      `   confirm_rounds=${step.values.confirm_rounds}` +
      `   plan_confirmed=${step.values.plan_confirmed}`,
  );

  return step;
}

const startWith = (text: string) => ({ messages: [new HumanMessage(text)] });
const replyWith = (text: string) => new Command({ resume: text });

const lastText = (messages: BaseMessage[]) => messages[messages.length - 1].content as string;

/**
 * YES/NO judge that also returns a one-line justification.
 *
 * The reason exists purely for the failure path: `expected 'NO' to be 'YES'`
 * says nothing about WHY the judge rejected the output, and re-running to find
 * out costs another round of API calls.
 *
 * The verdict is pulled with a \b(YES|NO)\b match rather than by splitting the
 * first line, since the model sometimes prefixes "Verdict:" or wraps the answer
 * in markdown. The instruction puts the verdict first, so the first match is it.
 */
async function judge(prompt: string): Promise<{ verdict: string; reason: string }> {
  const response = await miniModel.invoke([
    new HumanMessage(
      `${prompt}\n\nAnswer with YES or NO on the first line, then one sentence explaining why on the second line.`,
    ),
  ]);

  const text = (response.content as string).trim();
  const match = /\b(YES|NO)\b/i.exec(text);

  return {
    verdict: match ? match[1].toUpperCase() : `UNPARSEABLE(${text.slice(0, 40)})`,
    // Drop the verdict line; fall back to the whole reply if it was one line.
    reason: text.replace(/^[^\n]*\n?/, "").trim() || text,
  };
}

// =============================================================================
// SCENARIO 1 — vague start -> nudge -> plan -> approve
// =============================================================================

describe("conversationAgent: vague start, clarified, planned, approved (real LLM)", () => {
  let afterVagueOpener: Step;
  let afterClarification: Step;
  let afterApproval: Step;

  beforeAll(async () => {
    const graph = buildPreResearchGraph();
    const config = { configurable: { thread_id: randomUUID() } };

    afterVagueOpener = await runStep(graph, config, "step 1 / vague opener", startWith("I want to learn about war."));
    afterClarification = await runStep(
      graph,
      config,
      "step 2 / clarification",
      // No "go ahead" here on purpose: a specific topic is itself the request.
      replyWith("The Battle of Gettysburg, focus on the third day."),
    );
    afterApproval = await runStep(
      graph,
      config,
      "step 3 / approval",
      replyWith("Looks good, go ahead."),
    );
  }, 120_000);

  it("pauses at ask_user with a nudge when the topic is too vague", () => {
    expect(afterVagueOpener.next).toEqual(["ask_user"]);
    expect(afterVagueOpener.values.ready_to_plan).toBe(false);
    expect(afterVagueOpener.values.plan).toBeNull();
    expect(afterVagueOpener.values.clarify_rounds).toBe(1);

    // scope_topic writes the nudge into `messages` itself so a chat UI sees it,
    // and ask_user surfaces the same string as its interrupt payload.
    const nudge = afterVagueOpener.values.pending_question;
    expect(nudge.length).toBeGreaterThan(0);
    expect(lastText(afterVagueOpener.values.messages)).toBe(nudge);
    expect(afterVagueOpener.interruptValue).toBe(nudge);
  });

  it("proposes a plan and pauses at confirm_plan once the topic is workable", () => {
    expect(afterClarification.next).toEqual(["confirm_plan"]);
    expect(afterClarification.values.ready_to_plan).toBe(true);
    expect(afterClarification.values.rough_topic.length).toBeGreaterThan(0);
    expect(afterClarification.values.plan_confirmed).toBe(false);

    // Approving costs nothing; nothing has been rejected yet either.
    expect(afterClarification.values.confirm_rounds).toBe(0);

    const plan = afterClarification.values.plan;
    expect(plan).not.toBeNull();
    expect(plan!.final_topic.length).toBeGreaterThan(0);
    expect(plan!.angles).toHaveLength(ANGLES_PER_PLAN);
    expect(plan!.angles.every((a) => a.trim().length > 0)).toBe(true);
    expect(new Set(plan!.angles).size).toBe(ANGLES_PER_PLAN);

    // The plan is rendered into `messages` BEFORE confirm_plan pauses, and the
    // confirmation question is both the tail of that message and the payload.
    expect(lastText(afterClarification.values.messages)).toContain(CONFIRM_QUESTION);
    expect(afterClarification.interruptValue).toBe(CONFIRM_QUESTION);
  });

  it("hands the confirmed plan to the research seam without running research", () => {
    expect(afterApproval.next).toEqual([]);
    expect(afterApproval.values.plan_confirmed).toBe(true);

    const plan = afterApproval.values.plan!;
    expect(afterApproval.values.supervisor_messages).toHaveLength(1);

    const brief = afterApproval.values.supervisor_messages[0].content as string;
    expect(brief).toBe(planToBrief(plan));
    for (const angle of plan.angles) {
      expect(brief).toContain(angle);
    }

    // The point of the test graph: the handoff happened, the research did not.
    expect(afterApproval.values.notes).toEqual([]);
    expect(afterApproval.values.raw_notes).toEqual([]);
    expect(afterApproval.values.final_report).toBe("");
  });

  // The criterion below is spelled out deliberately. An earlier version of this
  // judge quoted scopeTopicPrompt's "good" example verbatim ("...focus on the
  // Pacific theater, or the European front?"), which is a narrowing WITHIN an
  // already-chosen war. That primed the judge to demand a sub-aspect and reject
  // a perfectly good nudge offering a choice of conflicts -- which is the only
  // narrowing available when the user has not named a war yet.
  it("the nudge is suggestive rather than open-ended (LLM-as-judge)", async () => {
    const { verdict, reason } = await judge(`A research agent was told only: "I want to learn about war." Its job at this point is to nudge the user toward something researchable.

It replied:
---
${afterVagueOpener.values.pending_question}
---

Its instructions require a SUGGESTIVE nudge: one that puts a concrete option, or a small choice of options, on the table, so the user can move forward by accepting or declining in a few words. Naming specific conflicts, theaters, periods or questions all count as concrete options -- at this stage no particular war has been chosen yet, so proposing which wars to look at is exactly the right kind of narrowing.

What violates the instructions is an OPEN-ENDED reply that hands the question back to the user without proposing anything, e.g. "Could you be more specific about what aspect interests you?"

Does the reply put at least one concrete option on the table, rather than merely asking the user to be more specific?`);

    console.log(`  judge  | ${verdict} -- ${reason}`);
    expect(verdict).toBe("YES");
  }, 30_000);

  it("the angles are distinct and on-topic (LLM-as-judge)", async () => {
    const plan = afterClarification.values.plan!;
    const { verdict, reason } = await judge(`A research agent was asked to research the Battle of Gettysburg, focusing on the third day. It proposed this plan:

Topic: ${plan.final_topic}
Angles:
${plan.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Are all of these angles genuinely about the Battle of Gettysburg, AND substantively distinct from one another (not restatements of the same line of inquiry)?`);

    console.log(`  judge  | ${verdict} -- ${reason}`);
    expect(verdict).toBe("YES");
  }, 30_000);
});

// =============================================================================
// SCENARIO 2 — angle-level feedback revises the plan but holds the topic
// =============================================================================

describe("conversationAgent: angle-level revision preserves the topic (real LLM)", () => {
  let afterOpener: Step;
  let afterAngleFeedback: Step;
  let afterApproval: Step;

  beforeAll(async () => {
    const graph = buildPreResearchGraph();
    const config = { configurable: { thread_id: randomUUID() } };

    afterOpener = await runStep(graph, config, "step 1 / specific opener", startWith("Research the Battle of Waterloo for me."));
    afterAngleFeedback = await runStep(
      graph,
      config,
      "step 2 / angle feedback",
      replyWith(
        "Drop any logistics or supply-line angle, and add one specifically on battlefield medicine and treatment of the wounded.",
      ),
    );
    afterApproval = await runStep(graph, config, "step 3 / approval", replyWith("Perfect, run it."));
  }, 120_000);

  it("goes straight to a plan when the opening request is already specific", () => {
    expect(afterOpener.next).toEqual(["confirm_plan"]);
    expect(afterOpener.values.clarify_rounds).toBe(0); // no nudge needed
    expect(afterOpener.values.confirm_rounds).toBe(0);
    expect(afterOpener.values.plan!.angles).toHaveLength(ANGLES_PER_PLAN);
  });

  it("replans on angle feedback, spending exactly one confirmation round", () => {
    expect(afterAngleFeedback.next).toEqual(["confirm_plan"]);
    expect(afterAngleFeedback.values.confirm_rounds).toBe(1);
    expect(afterAngleFeedback.values.plan_confirmed).toBe(false);
    expect(afterAngleFeedback.values.plan!.angles).toHaveLength(ANGLES_PER_PLAN);

    // The topic is the stable anchor across plan revisions: angle-level
    // feedback must leave rough_topic alone (only topic-level feedback clears it).
    expect(afterAngleFeedback.values.rough_topic).toBe(afterOpener.values.rough_topic);

    // A genuinely new plan, not the same one handed back.
    expect(afterAngleFeedback.values.plan!.angles.join("|")).not.toBe(
      afterOpener.values.plan!.angles.join("|"),
    );
  });

  it("approving does not spend a confirmation round", () => {
    expect(afterApproval.next).toEqual([]);
    expect(afterApproval.values.plan_confirmed).toBe(true);
    expect(afterApproval.values.confirm_rounds).toBe(1); // unchanged by the approval
    expect(afterApproval.values.supervisor_messages).toHaveLength(1);
    expect(afterApproval.values.notes).toEqual([]);
    expect(afterApproval.values.final_report).toBe("");
  });

  it("the revised plan still concerns the same battle (LLM-as-judge)", async () => {
    const plan = afterAngleFeedback.values.plan!;
    const { verdict, reason } = await judge(`Here is a research plan:

Topic: ${plan.final_topic}
Angles:
${plan.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Is this plan about the Battle of Waterloo (the 1815 battle in present-day Belgium that ended the Napoleonic Wars)?`);

    console.log(`  judge  | ${verdict} -- ${reason}`);
    expect(verdict).toBe("YES");
  }, 30_000);

  it("the revised plan applies the angle feedback (LLM-as-judge)", async () => {
    const plan = afterAngleFeedback.values.plan!;
    const { verdict, reason } = await judge(`A user reviewed a research plan and asked: "Drop any logistics or supply-line angle, and add one specifically on battlefield medicine and treatment of the wounded."

The revised plan is:

Angles:
${plan.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Did the revision honor BOTH parts of that request -- that is, at least one angle is specifically about battlefield medicine or treatment of the wounded, AND no angle is primarily about logistics or supply lines?`);

    console.log(`  judge  | ${verdict} -- ${reason}`);
    expect(verdict).toBe("YES");
  }, 30_000);
});

// =============================================================================
// SCENARIO 3 — a bare, specific topic is a request, not small talk
// =============================================================================
//
// This is the case that used to need a second condition in scopeTopicPrompt
// ("has the user clearly signaled they want to proceed?"). A topic this precise
// has no other reason to be typed at a war research agent, and confirm_plan is
// already the consent gate -- a better-informed one, since it shows the plan
// first. Nudging here would cost a round-trip and a clarify round to learn
// nothing, so the prompt now defaults to proceeding.
// =============================================================================

describe("conversationAgent: a bare specific topic goes straight to a plan (real LLM)", () => {
  let afterBareTopic: Step;

  beforeAll(async () => {
    const graph = buildPreResearchGraph();
    const config = { configurable: { thread_id: randomUUID() } };

    // No verb, no question, no imperative -- just the subject and its bounds.
    afterBareTopic = await runStep(
      graph,
      config,
      "step 1 / bare topic",
      startWith("Stalingrad, November 1942 to February 1943 — the encirclement."),
    );
  }, 60_000);

  it("does not ask the user to confirm that they want research", () => {
    expect(afterBareTopic.next).toEqual(["confirm_plan"]);
    expect(afterBareTopic.values.ready_to_plan).toBe(true);
    expect(afterBareTopic.values.clarify_rounds).toBe(0); // no nudge spent
    expect(afterBareTopic.values.pending_question).toBe("");
  });

  it("proposes a full plan and pauses for approval", () => {
    const plan = afterBareTopic.values.plan;
    expect(plan).not.toBeNull();
    expect(plan!.final_topic.length).toBeGreaterThan(0);
    expect(plan!.angles).toHaveLength(ANGLES_PER_PLAN);
    expect(afterBareTopic.values.plan_confirmed).toBe(false);
    expect(afterBareTopic.interruptValue).toBe(CONFIRM_QUESTION);
  });
});

// =============================================================================
// SCENARIO 4 — an explicit hold is still honored
// =============================================================================
//
// The guard on scenario 3: defaulting to proceed must not become always
// proceeding. When the user says outright that they do not want research yet,
// scope_topic takes them at their word and nudges instead of planning.
// =============================================================================

describe("conversationAgent: an explicit hold is honored (real LLM)", () => {
  let afterHold: Step;

  beforeAll(async () => {
    const graph = buildPreResearchGraph();
    const config = { configurable: { thread_id: randomUUID() } };

    // A perfectly researchable topic, with the user declining research on it.
    afterHold = await runStep(
      graph,
      config,
      "step 1 / explicit hold",
      startWith("I'm curious about the Battle of Midway, but don't research it yet."),
    );
  }, 60_000);

  it("nudges instead of planning when the user has asked to hold off", () => {
    expect(afterHold.next).toEqual(["ask_user"]);
    expect(afterHold.values.ready_to_plan).toBe(false);
    expect(afterHold.values.plan).toBeNull();
    expect(afterHold.values.clarify_rounds).toBe(1);
    expect(afterHold.values.pending_question.length).toBeGreaterThan(0);
  });

  it("acknowledges the hold rather than pressing to start (LLM-as-judge)", async () => {
    const { verdict, reason } = await judge(`A user told a research agent: "I'm curious about the Battle of Midway, but don't research it yet."

The agent replied:
---
${afterHold.values.pending_question}
---

The agent's instructions say that when a user explicitly asks it to hold off, it should acknowledge that and make clear it is ready whenever they are, rather than pressing them to start now.

Does the reply respect the user's request to wait, rather than pushing them to begin research immediately?`);

    console.log(`  judge  | ${verdict} -- ${reason}`);
    expect(verdict).toBe("YES");
  }, 30_000);
});
