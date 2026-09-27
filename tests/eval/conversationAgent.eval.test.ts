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
import { scorePlan, logScore, type Score } from "./angleJudges.js";
import { MAX_ANGLES_PER_PLAN } from "../../src/config.js";

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
    // MAX_ANGLES_PER_PLAN is a ceiling, not a quota — propose_plan is free to return
    // fewer when a topic does not support more, so this asserts a range, not a count.
    expect(plan!.angles.length).toBeGreaterThanOrEqual(1);
    expect(plan!.angles.length).toBeLessThanOrEqual(MAX_ANGLES_PER_PLAN);
    expect(plan!.angles.every((a) => a.trim().length > 0)).toBe(true);
    expect(new Set(plan!.angles).size).toBe(plan!.angles.length);

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

  // The former "angles are distinct and on-topic" judge lived here. It is superseded by
  // the ANGLE QUALITY suite at the bottom of this file, which scores overlap per PAIR
  // rather than asking one question about the whole set — see angleJudges.ts for why that
  // distinction matters.
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
    expect(afterOpener.values.plan!.angles.length).toBeLessThanOrEqual(MAX_ANGLES_PER_PLAN);
  });

  it("replans on angle feedback, spending exactly one confirmation round", () => {
    expect(afterAngleFeedback.next).toEqual(["confirm_plan"]);
    expect(afterAngleFeedback.values.confirm_rounds).toBe(1);
    expect(afterAngleFeedback.values.plan_confirmed).toBe(false);
    expect(afterAngleFeedback.values.plan!.angles.length).toBeLessThanOrEqual(MAX_ANGLES_PER_PLAN);

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
    expect(plan!.angles.length).toBeGreaterThanOrEqual(1);
    expect(plan!.angles.length).toBeLessThanOrEqual(MAX_ANGLES_PER_PLAN);
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

// =============================================================================
// ANGLE QUALITY — is a proposed angle actually worth researching?
// =============================================================================
//
// The scenarios above check that the pre-research loop ROUTES correctly. This block
// checks the thing routing cannot check: whether the angles `propose_plan` invents are
// any good. It is the regression test for the anti-generic rules in proposePlanPrompt.
//
// It does NOT drive the graph. It calls `makeProposePlanNode` directly against a seeded
// state, which keeps it off the hand-copied wiring above (so it cannot drift from
// production) and costs one fullModel call per seed. Nothing here spawns a supervisor, a
// researcher or a Tavily search.
//
// Cost: 3 fullModel calls + ~30 miniModel judge calls per run.
//
// THE SEEDS are three topics chosen to be unalike — a battle, a condition of service, an
// evaluative comparison. That is a sampling choice and nothing more: no code classifies
// a user's question, and the rules in proposePlanPrompt are tests the model applies to
// its own output rather than branches on the kind of question. Three seeds exist so a
// change that only works for battles cannot pass. `rough_topic` is hand-written rather
// than produced by scope_topic so the inputs stay fixed and the prompt is the only
// variable across runs.
//
// THRESHOLDS were set from measurement, not chosen up front. Before the anti-generic
// rules `specific` scored 1/9; after, it scored 8, 7, 9 and 7 out of 9 across four runs.
// The aggregate floor of 6 sits below all of those and far above the old behaviour, so
// this assertion would have FAILED against the previous prompt — which is the only thing
// that makes it a real test rather than a rubber stamp. `researchable` and `distinct`
// were already at ceiling before the change (8/9 and 9/9) and measured 8-9/9 after; their
// floors are regression guards set one below measurement to absorb a single judge wobble.
//
// The variance is concentrated almost entirely in the WWII seed, which is much the
// broadest question of the three: it has scored anywhere from 1/3 to 3/3 while Gettysburg
// and Napoleon sit at 3/3. That is the breadth-versus-ceiling tension described in
// proposePlanPrompt — with only three angles, a genuinely broad question cannot be covered
// by three contested particulars, and the angle that stretches to span it is the one that
// fails `specific`. Hence an aggregate threshold rather than a per-seed one.
// =============================================================================

const ANGLE_QUALITY_SEEDS = [
  {
    question: "I want to research the third day of the Battle of Gettysburg.",
    rough_topic: "The third day of the Battle of Gettysburg, 3 July 1863",
  },
  {
    question: "What was daily life like for soldiers in World War II?",
    rough_topic: "What daily life was like for soldiers serving in World War II",
  },
  {
    question: "Why was Napoleon better than other commanders?",
    rough_topic: "Why Napoleon outperformed the other commanders of his era",
  },
];

/** Minimal state for calling propose_plan on its own: it reads only these three fields. */
const seedState = (question: string, rough_topic: string) =>
  ({
    messages: [new HumanMessage(question)],
    ready_to_plan: true,
    rough_topic,
    pending_question: "",
    plan: null,
    plan_confirmed: false,
    confirm_rounds: 0,
    clarify_rounds: 0,
    supervisor_messages: [],
    raw_notes: [],
    notes: [],
    final_report: "",
  }) as unknown as ConversationStateType;

describe("propose_plan: the angles are worth researching (real LLM)", () => {
  const plans: PlanType[] = [];
  const scores: Score[] = [];

  beforeAll(async () => {
    const proposePlan = makeProposePlanNode(fullModel);

    const results = await Promise.all(
      ANGLE_QUALITY_SEEDS.map(async ({ question, rough_topic }) => {
        const command = (await proposePlan(seedState(question, rough_topic))) as Command;
        const plan = (command.update as { plan: PlanType }).plan;
        return { plan, score: await scorePlan(plan.final_topic, question, plan.angles) };
      }),
    );

    for (const [i, { plan, score }] of results.entries()) {
      plans.push(plan);
      scores.push(score);
      console.log(`\n  seed   | "${ANGLE_QUALITY_SEEDS[i].question}"`);
      console.log(`  topic  | ${plan.final_topic}`);
      plan.angles.forEach((a, j) => console.log(`  angle ${j + 1}| ${a}`));
      logScore(score);
    }
  }, 300_000);

  const total = (pick: (s: Score) => { pass: number; of: number }) =>
    scores.reduce((acc, s) => ({ pass: acc.pass + pick(s).pass, of: acc.of + pick(s).of }), {
      pass: 0,
      of: 0,
    });

  it("names particulars from inside the subject, not categories", () => {
    // The headline assertion. Scored 1/9 before the anti-generic rules, 7-8/9 after.
    const { pass, of } = total((s) => s.specific);
    console.log(`  specific total | ${pass}/${of}`);
    expect(pass).toBeGreaterThanOrEqual(6);
  });

  it("asks questions that have to be researched rather than looked up", () => {
    // Regression guard: pushing for specificity tempts the model toward famous set
    // pieces, which are the most written-about and so the most lookup-like.
    const { pass, of } = total((s) => s.researchable);
    console.log(`  researchable total | ${pass}/${of}`);
    expect(pass).toBeGreaterThanOrEqual(8);
  });

  it("does not ask the same question twice", () => {
    // Regression guard. Question-level overlap measured 9/9 both before and after, so
    // this protects a property that is already good rather than chasing one that is not.
    const { pass, of } = total((s) => s.distinct);
    console.log(`  distinct total | ${pass}/${of}`);
    expect(pass).toBeGreaterThanOrEqual(8);
  });

  it("still answers the question the user actually asked", () => {
    // The over-narrowing guard — the one that catches specificity bought by retreating
    // into one corner of the topic. It is what caught an intermediate version of the
    // prompt whose angles were beautifully specific and all probed the same episode.
    //
    // Two of three rather than all three, because the Gettysburg seed flips roughly one
    // run in three. That is not pure noise: its plan covers Lee's decision, the artillery
    // ruse and Stuart's cavalry but not Culp's Hill, and on the runs it fails the judge
    // says so — "does not comprehensively cover the entire third day". In other words it
    // is partly measuring collective exhaustiveness, which this project deliberately does
    // NOT target (at most three angles cannot exhaust a topic, and for open questions the
    // notion is not even well defined — see TODO.md). Tightening the judge until that
    // stopped would mean optimising for a goal we dropped on purpose.
    //
    // The guard still bites: during the over-narrowing regression this scored 1/3 and
    // then 0/3, both of which fail the threshold below.
    const passing = scores.filter((s) => s.intent.verdict === "YES").length;
    scores.forEach((s, i) => {
      if (s.intent.verdict !== "YES") {
        console.log(`  intent NO | ${ANGLE_QUALITY_SEEDS[i].question}\n            | ${s.intent.reason}`);
      }
    });
    expect(passing).toBeGreaterThanOrEqual(2);
  });

  it("never exceeds the angle ceiling, and may return fewer", () => {
    for (const plan of plans) {
      expect(plan.angles.length).toBeGreaterThanOrEqual(1);
      expect(plan.angles.length).toBeLessThanOrEqual(MAX_ANGLES_PER_PLAN);
    }
  });
});
