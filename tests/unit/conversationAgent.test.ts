import { describe, it, expect } from "vitest";
import { Command } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  makeProposePlanNode,
  makeReportGenerator,
  type IllustrateFn,
  type ProposePlanModel,
} from "../../src/conversationAgent.js";
import { ConversationStateType } from "../../src/states/conversationState.js";
import { CONFIRM_QUESTION } from "../../src/plan.js";
import { MAX_ANGLES_PER_PLAN, MAX_CONFIRM_ROUNDS } from "../../src/config.js";

// =============================================================================
// propose_plan, with an injected fake model.
//
// These cover the plumbing the eval cannot cheaply cover: the angle ceiling, the fact
// that FEWER angles now pass through untouched, and the two routes out of the node.
// Angle QUALITY is not testable here — a fake model returns whatever the fake says — so
// that lives in tests/eval/conversationAgent.eval.test.ts against real models.
//
// makeProposePlanNode takes its model as a parameter precisely so this file needs no
// vi.mock: see the dependency-injection note in CLAUDE.md.
// =============================================================================

/** Minimal ProposePlanModel returning a canned structured response. */
const fakeModel = (angles: string[], final_topic = "A sharpened topic"): ProposePlanModel => ({
  withStructuredOutput: () => ({
    invoke: async () => ({ final_topic, angles }),
  }),
});

const stateWith = (overrides: Partial<ConversationStateType> = {}) =>
  ({
    messages: [new HumanMessage("Tell me about the Battle of Kursk.")],
    ready_to_plan: true,
    rough_topic: "The Battle of Kursk, July 1943",
    pending_question: "",
    plan: null,
    plan_confirmed: false,
    confirm_rounds: 0,
    clarify_rounds: 0,
    supervisor_messages: [],
    raw_notes: [],
    notes: [],
    final_report: "",
    ...overrides,
  }) as unknown as ConversationStateType;

/** `goto` may be a bare string or an array depending on how the Command was built. */
const gotoOf = (command: Command) =>
  Array.isArray(command.goto) ? command.goto : [command.goto];

const planOf = (command: Command) =>
  (command.update as { plan: { final_topic: string; angles: string[] } }).plan;

const run = async (model: ProposePlanModel, state: ConversationStateType) =>
  (await makeProposePlanNode(model)(state)) as Command;

describe("propose_plan: the angle ceiling", () => {
  it("truncates to MAX_ANGLES_PER_PLAN when the model returns too many", async () => {
    // The prompt and the schema both ask for at most MAX_ANGLES_PER_PLAN, but neither
    // binds the model — and every surplus angle would become another researcher.
    const tooMany = Array.from({ length: MAX_ANGLES_PER_PLAN + 3 }, (_, i) => `angle ${i + 1}`);
    const command = await run(fakeModel(tooMany), stateWith());

    expect(planOf(command).angles).toHaveLength(MAX_ANGLES_PER_PLAN);
    // Truncation keeps the leading angles rather than sampling.
    expect(planOf(command).angles).toEqual(tooMany.slice(0, MAX_ANGLES_PER_PLAN));
  });

  it("passes a shorter plan through untouched", async () => {
    // The ceiling is not a quota. A topic that only supports two angles gets two, since
    // a padded third is a wasted researcher.
    const two = ["first angle", "second angle"];
    const command = await run(fakeModel(two), stateWith());

    expect(planOf(command).angles).toEqual(two);
  });

  it("does not invent angles when the model returns a single one", async () => {
    const command = await run(fakeModel(["the only angle"]), stateWith());

    expect(planOf(command).angles).toEqual(["the only angle"]);
  });
});

describe("propose_plan: routing", () => {
  it("routes to confirm_plan and renders the plan plus the question into messages", async () => {
    const command = await run(fakeModel(["a", "b"]), stateWith());
    const update = command.update as { plan_confirmed: boolean; messages: { content: string }[] };

    expect(gotoOf(command)).toContain("confirm_plan");
    expect(update.plan_confirmed).toBe(false);

    // confirm_plan re-executes from the top on resume and so holds nothing itself; the
    // proposal has to be in state and in `messages` before it pauses.
    const rendered = update.messages[0].content;
    expect(rendered).toContain("A sharpened topic");
    expect(rendered).toContain(CONFIRM_QUESTION);
  });

  it("auto-accepts once MAX_CONFIRM_ROUNDS rejections have been spent", async () => {
    const command = await run(
      fakeModel(["a", "b"]),
      stateWith({ confirm_rounds: MAX_CONFIRM_ROUNDS }),
    );
    const update = command.update as { plan_confirmed: boolean; messages: { content: string }[] };

    expect(gotoOf(command)).toContain("dispatch_research");
    expect(update.plan_confirmed).toBe(true);

    // The user is told rather than asked, so the confirmation question must NOT appear.
    expect(update.messages[0].content).not.toContain(CONFIRM_QUESTION);
  });

  it("still asks on the round before the cap", async () => {
    const command = await run(
      fakeModel(["a", "b"]),
      stateWith({ confirm_rounds: MAX_CONFIRM_ROUNDS - 1 }),
    );

    expect(gotoOf(command)).toContain("confirm_plan");
  });
});

// =============================================================================
// report_generator, with both its model and its illustration pass injected.
//
// The illustration pass itself is covered in tests/unit/illustrate.test.ts; what matters
// here is the wiring: that the ILLUSTRATED text is what reaches state, and that a failure
// in the decorations cannot cost the user a report that took a full research run to earn.
// =============================================================================

/** Minimal report model: returns a canned report body as an AI message. */
const fakeReportModel = (body: string) => ({
  invoke: async () => new AIMessage(body) as AIMessage,
});

const REPORT_BODY = "# Austerlitz\n\n## The Approach March\n\nProse.";

const reportState = (overrides: Partial<ConversationStateType> = {}) =>
  ({
    messages: [],
    notes: ["a finding", "another finding"],
    plan: { final_topic: "Austerlitz", angles: ["The approach march"] },
    ...overrides,
  }) as unknown as ConversationStateType;

describe("report_generator", () => {
  it("writes the ILLUSTRATED report to both final_report and messages", async () => {
    const illustrate: IllustrateFn = async (report) => `${report}\n\n![a](https://x/1.jpg)`;
    const node = makeReportGenerator(fakeReportModel(REPORT_BODY), illustrate);

    const update = await node(reportState());

    expect(update.final_report).toContain("![a](https://x/1.jpg)");
    expect(String(update.messages[0].content)).toContain("![a](https://x/1.jpg)");
  });

  it("hands the illustration pass the report text and the research notes", async () => {
    // The notes are what ground an image query in what the research actually found, rather
    // than in the words of the approved angle.
    const seen: { report?: string; notes?: string[] } = {};
    const illustrate: IllustrateFn = async (report, notes) => {
      seen.report = report;
      seen.notes = notes;
      return report;
    };

    await makeReportGenerator(fakeReportModel(REPORT_BODY), illustrate)(reportState());

    expect(seen.report).toBe(REPORT_BODY);
    expect(seen.notes).toEqual(["a finding", "another finding"]);
  });

  it("keeps the unillustrated report when the illustration pass returns it unchanged", async () => {
    const node = makeReportGenerator(fakeReportModel(REPORT_BODY), async (report) => report);
    expect((await node(reportState())).final_report).toBe(REPORT_BODY);
  });

  it("keeps the report when the illustration pass throws", async () => {
    // illustrateReport is contracted not to throw; this pins the node's own guard, because
    // report_generator is the last place a finished report can be lost.
    const node = makeReportGenerator(fakeReportModel(REPORT_BODY), async () => {
      throw new Error("Commons exploded");
    });

    const update = await node(reportState());

    expect(update.final_report).toBe(REPORT_BODY);
    expect(String(update.messages[0].content)).toContain(REPORT_BODY);
  });

  it("still produces a report when there is no plan to render into the prompt", async () => {
    const node = makeReportGenerator(fakeReportModel(REPORT_BODY), async (report) => report);
    expect((await node(reportState({ plan: null }))).final_report).toBe(REPORT_BODY);
  });
});
