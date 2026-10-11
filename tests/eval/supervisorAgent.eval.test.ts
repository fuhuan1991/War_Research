import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { makeSupervisorNode } from "../../src/supervisorAgent.js";
import { planToBrief, PlanType } from "../../src/plan.js";

// =============================================================================
// WHAT THIS MEASURES
// =============================================================================
//
// The coverage gate in `supervisorAssessmentPrompt`: the assessment renders a
// verdict per angle (COVERED / PARTIAL / NOT COVERED / EXHAUSTED) and may only
// decide to finish when every angle is COVERED or EXHAUSTED.
//
// It is deliberately TWO-SIDED, which is the lesson `angleJudges.ts` records
// about anything LLM-scored: a gate that never lets go passes every
// "keep researching" test, and a gate that is a rubber stamp passes every
// "stop now" test. Each seed below is paired with one that fails if the gate
// errs the opposite way:
//
//   under-covered  <-> fully-covered     (does it stop when it should?)
//   exhausted      <-> first-assessment  (is EXHAUSTED a reasoned verdict or a
//                                         way out of researching at all?)
//
// Unlike the angle evals this needs no judge. The verdict labels are
// structured, and the decision is a tool call, so every assertion here is a
// deterministic string or tool-name check. Nothing in this file has to be
// calibrated.
//
// Cost: one `fullModel` assessment plus one `nanoModel` dispatch per seed, four
// seeds, no researchers spawned -- `makeSupervisorNode` only assesses and
// routes; `supervisor_tool_node` is what spawns sub-agents, and it is never
// called here. Roughly $0.03 a seed. Run alone with
// `npm run llm-test:supervisor`.

const PLAN: PlanType = {
  final_topic: "The tank engagement at Prokhorovka during the Battle of Kursk, 12 July 1943.",
  angles: [
    "What were the actual tank losses suffered by both the German II SS Panzer Corps and the Soviet 5th Guards Tank Army at Prokhorovka on 12 July 1943, and how do these figures compare to postwar claims?",
    "How did the terrain and tactical deployment at Prokhorovka influence the outcome of the tank battle on 12 July 1943?",
    "What were the immediate operational consequences of the Prokhorovka engagement for both the German and Soviet forces in the southern sector of the Kursk salient?",
  ],
};

// Notes that genuinely answer their angle, with the figures and named sources a
// verdict of COVERED has to rest on. Short by design -- real compressed_research
// runs 10-25k chars, and the gate is being tested, not the summariser.
const NOTES_ANGLE_1 =
  "Revised figures converge across The Tank Museum, Osprey and The Dupuy Institute: about 910 tanks " +
  "engaged in total (294 German, 616 Soviet). The Soviet 5th Guards Tank Army lost 246-359 tanks and " +
  "AFVs, 207 of them irreparable. The German II SS Panzer Corps lost 16-43, most repairable, with only " +
  "6-20 write-offs. Soviet-era claims of 1,200+ tanks destroyed are now treated as Cold War propaganda; " +
  "the discrepancy is explained by German repair doctrine and by Rotmistrov's need to justify his losses.";

const NOTES_ANGLE_2 =
  "The ground channelled the attack: high wheatfields, ravines, an anti-tank ditch and the Prokhorovka " +
  "rail embankment left a frontage of under three kilometres. Soviet tactics required closing to short " +
  "range to defeat German armour, but reconnaissance failed to identify their own anti-tank ditch, and " +
  "two battalions of 29th Tank Corps drove into it under fire. German units fought from prepared " +
  "positions on Hill 252.2 with anti-tank guns and air support.";

const NOTES_ANGLE_3 =
  "Tactically the Germans inflicted disproportionate losses but did not break through. Operation Citadel " +
  "was cancelled on 13 July, the day after. Both sides were exhausted, but the Soviets retained enough " +
  "armour to begin Operations Kutuzov and Rumyantsev, and the strategic initiative in the east passed " +
  "permanently to the Red Army; Prokhorovka marks the end of major German offensives there.";

// =============================================================================
// SEED HELPERS
// =============================================================================

/**
 * One research turn: the dispatch message and the tool messages answering it.
 *
 * Topics and results are paired here rather than built as two separate lists
 * with matching indices, because the first version of this file did the latter
 * and numbered each turn's tool_call_ids from 1 again — so turn 2's results
 * referenced ids that did not exist and OpenAI rejected the whole history with
 * "tool_call_id of 'seeded-3' not found in tool_calls of previous message".
 * The turn number keeps ids unique across turns.
 */
const turn = (n: number, pairs: [topic: string, result: string][]): BaseMessage[] => {
  const toolCalls = pairs.map(([researchTopic], i) => ({
    name: "ConductResearch",
    id: `t${n}-c${i + 1}`,
    args: { researchTopic },
  }));

  return [
    new AIMessage({ content: "", tool_calls: toolCalls }),
    ...pairs.map(([, result], i) => new ToolMessage({ content: result, tool_call_id: toolCalls[i].id })),
  ];
};

type Outcome = { assessment: string; tools: string[] };

async function runNode(messages: BaseMessage[], research_iterations: number): Promise<Outcome> {
  const result = await makeSupervisorNode()({
    supervisor_messages: messages,
    notes: [],
    raw_notes: [],
    research_iterations,
  } as never);

  const [assessment, decision] = result.update.supervisor_messages as [AIMessage, AIMessage];
  return {
    assessment: assessment.content as string,
    tools: (decision.tool_calls ?? []).map((tc) => tc.name),
  };
}

/**
 * Counts the verdict labels. "NOT COVERED" contains "COVERED", so the bare count
 * is corrected rather than matched with a lookbehind -- a model that writes
 * "Not Covered" or "not covered" still has to be counted correctly.
 */
const labelsIn = (text: string) => {
  const upper = text.toUpperCase();
  const count = (pattern: RegExp) => (upper.match(pattern) ?? []).length;
  const notCovered = count(/NOT COVERED/g);
  return {
    covered: count(/COVERED/g) - notCovered,
    partial: count(/PARTIAL/g),
    notCovered,
    exhausted: count(/EXHAUSTED/g),
  };
};

// =============================================================================
// THE RUN
// =============================================================================

const outcomes: Record<string, Outcome> = {};

beforeAll(async () => {
  const brief = new HumanMessage(planToBrief(PLAN));
  const priorAssessment = new AIMessage("<Assessment recorded> all three angles still need research.");

  // Two of three angles answered. The gate must keep going, and must say which
  // angle is short.
  const underCovered = [
    brief,
    priorAssessment,
    ...turn(1, [
      [PLAN.angles[0], NOTES_ANGLE_1],
      [PLAN.angles[1], NOTES_ANGLE_2],
    ]),
  ];

  // The same seed plus a second turn that answers the third angle. The gate must
  // let go. Without this case a gate that always continues would look perfect.
  const fullyCovered = [
    ...underCovered,
    new AIMessage("<Assessment recorded> the operational consequences angle is still unanswered."),
    ...turn(2, [[PLAN.angles[2], NOTES_ANGLE_3]]),
  ];

  // An angle no public source answers, already attempted twice, with the prior
  // assessments saying so. EXHAUSTED exists for exactly this, and the run that
  // motivated it twice failed to find tabulated ration scales.
  const exhaustedPlan: PlanType = {
    final_topic: PLAN.final_topic,
    angles: [
      PLAN.angles[0],
      "What did individual tank crewmen of the Soviet 29th Tank Corps write in private letters home on the evening of 12 July 1943?",
    ],
  };
  const noSources =
    "Searched for published or digitised private correspondence of 29th Tank Corps crewmen for 12 July 1943 " +
    "across the Russian State Military Archive (RGVA) catalogue, Prokhorovka museum collections, Podvig Naroda " +
    "and three published letter anthologies. No letters from that formation and date are published or " +
    "digitised; the archival holdings are not catalogued to individual-letter level and are closed to " +
    "remote access. Secondary accounts quote only post-war veteran interviews, not contemporaneous letters.";
  const exhausted = [
    new HumanMessage(planToBrief(exhaustedPlan)),
    new AIMessage("<Assessment recorded> both angles need research."),
    ...turn(1, [
      [exhaustedPlan.angles[0], NOTES_ANGLE_1],
      [exhaustedPlan.angles[1], noSources],
    ]),
    new AIMessage(
      "<Assessment recorded> the letters for angle 2 could not be found; trying a different archive.",
    ),
    ...turn(2, [[exhaustedPlan.angles[1], noSources]]),
  ];

  // Nothing researched at all. EXHAUSTED must not appear: an angle nobody has
  // tried is NOT COVERED, and a gate that rubber-stamps here could finish a run
  // having spent nothing.
  const firstAssessment = [brief];

  const [a, b, c, d] = await Promise.all([
    runNode(underCovered, 1),
    runNode(fullyCovered, 2),
    runNode(exhausted, 2),
    runNode(firstAssessment, 0),
  ]);

  outcomes.underCovered = a;
  outcomes.fullyCovered = b;
  outcomes.exhausted = c;
  outcomes.firstAssessment = d;

  // Printed for the same reason angleJudges.ts prints its scores: when an
  // assertion below fails, the useful question is which verdict the model
  // actually rendered, and a re-run to find out costs another four calls.
  for (const [seed, outcome] of Object.entries(outcomes)) {
    const l = labelsIn(outcome.assessment);
    console.log(
      `[${seed}] ${outcome.tools.join(",") || "no tool call"} — ` +
        `covered=${l.covered} partial=${l.partial} notCovered=${l.notCovered} exhausted=${l.exhausted}`,
    );
  }
}, 180_000);

// =============================================================================
// ASSERTIONS
// =============================================================================

describe("coverage gate: it keeps researching while an angle is short", () => {
  it("does not finish when only two of three angles are answered", () => {
    expect(outcomes.underCovered.tools).toContain("ConductResearch");
    expect(outcomes.underCovered.tools).not.toContain("CompleteResearch");
  });

  it("labels the unresearched angle PARTIAL or NOT COVERED", () => {
    const labels = labelsIn(outcomes.underCovered.assessment);
    expect(labels.partial + labels.notCovered).toBeGreaterThan(0);
  });

  it("names the operational-consequences angle as the one still missing", () => {
    expect(outcomes.underCovered.assessment.toLowerCase()).toMatch(/consequence|kutuzov|rumyantsev|citadel/);
  });
});

describe("coverage gate: it lets go once every angle is answered", () => {
  it("finishes when all three angles are answered", () => {
    expect(outcomes.fullyCovered.tools).toContain("CompleteResearch");
    expect(outcomes.fullyCovered.tools).not.toContain("ConductResearch");
  });

  it("records no angle as NOT COVERED", () => {
    expect(labelsIn(outcomes.fullyCovered.assessment).notCovered).toBe(0);
  });

  it("records a COVERED verdict for every angle", () => {
    expect(labelsIn(outcomes.fullyCovered.assessment).covered).toBeGreaterThanOrEqual(PLAN.angles.length);
  });
});

describe("EXHAUSTED: available on a tried-and-failed angle", () => {
  it("reaches EXHAUSTED rather than re-dispatching a third time", () => {
    expect(labelsIn(outcomes.exhausted.assessment).exhausted).toBeGreaterThan(0);
  });

  it("finishes rather than looping to the turn cap", () => {
    expect(outcomes.exhausted.tools).toContain("CompleteResearch");
  });
});

describe("EXHAUSTED: not a way out of researching at all", () => {
  it("is not used on the first assessment, when no sub-agent has run", () => {
    expect(labelsIn(outcomes.firstAssessment.assessment).exhausted).toBe(0);
  });

  it("labels every angle NOT COVERED and dispatches research", () => {
    expect(labelsIn(outcomes.firstAssessment.assessment).notCovered).toBeGreaterThanOrEqual(PLAN.angles.length);
    expect(outcomes.firstAssessment.tools).toContain("ConductResearch");
  });
});
