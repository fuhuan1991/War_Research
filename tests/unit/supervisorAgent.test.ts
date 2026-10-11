import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockFullModelInvoke, mockDispatchingModelInvoke, mockResearchAgentInvoke } = vi.hoisted(() => ({
  mockFullModelInvoke: vi.fn(),
  mockDispatchingModelInvoke: vi.fn(),
  mockResearchAgentInvoke: vi.fn(),
}));

vi.mock("../../src/model.js", () => ({
  fullModel: { invoke: mockFullModelInvoke },
  // dispatchingModel is created via nanoModel.bindTools(...) at module load time
  nanoModel: {
    bindTools: () => ({ invoke: mockDispatchingModelInvoke }),
  },
}));

// supervisorAgent imports researchAgent, which pulls in tavilySearch and its module-scope
// Tavily client. Mocking the sub-graph keeps this file from needing any API key.
vi.mock("../../src/researchAgent.js", () => ({
  researchAgent: { invoke: mockResearchAgentInvoke },
}));

vi.mock("../../src/config.js", () => ({
  MAX_SUPERVISOR_TURNS: 5,
  MAX_CONCURRENT_RESEARCH_UNITS: 3,
}));

import { makeSupervisorNode } from "../../src/supervisorAgent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRIEF = "Research topic:\nThe tank engagement at Prokhorovka, 12 July 1943.";

function makeState(overrides: Partial<{
  supervisor_messages: BaseMessage[];
  notes: string[];
  raw_notes: string[];
  research_iterations: number;
}> = {}) {
  return {
    supervisor_messages: [new HumanMessage(BRIEF)],
    notes: [],
    raw_notes: [],
    research_iterations: 0,
    ...overrides,
  };
}

function makeAIMessage(toolCalls: { name: string; id: string; args: Record<string, unknown> }[]): AIMessage {
  return new AIMessage({ content: "", tool_calls: toolCalls });
}

// A history long enough that a spread into the dispatch call would be unmistakable, with a
// recognisable string in every message type the channel carries.
function makeHistory(): BaseMessage[] {
  return [
    new HumanMessage(BRIEF),
    new AIMessage("<Assessment recorded> an earlier assessment"),
    makeAIMessage([{ name: "ConductResearch", id: "old-1", args: { researchTopic: "an earlier dispatched topic" } }]),
    new ToolMessage({
      content: "an earlier researcher report",
      tool_call_id: "old-1",
    }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// supervisor_node
// ---------------------------------------------------------------------------

describe("supervisor_node", () => {
  it("records the assessment and the decision, and increments research_iterations", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded> three angles to cover");
    const decisionMsg = makeAIMessage([
      { name: "ConductResearch", id: "tc1", args: { researchTopic: "tank losses at Prokhorovka" } },
    ]);
    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(decisionMsg);

    const result = await makeSupervisorNode()(makeState() as never);

    expect(result.goto).toContain("supervisor_tool_node");
    expect(result.update.supervisor_messages).toEqual([assessmentMsg, decisionMsg]);
    expect(result.update.research_iterations).toBe(1);
  });

  // The dispatch model is deliberately given no message history: it only has to name a tool,
  // and the assessment it receives already states the decision and the sub-topics. The tool
  // messages it used to receive are whole researcher reports — a traced run measured this call
  // taking 60,939 prompt characters to emit 11 output tokens. Nothing else in this file pins
  // that call's message array, so without this test the spread can come back unnoticed.
  it("sends the dispatch model only the system prompt, the brief and the assessment", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded> one gap left to fill");
    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "CompleteResearch", id: "tc1", args: {} }]),
    );

    await makeSupervisorNode()(makeState({ supervisor_messages: makeHistory(), research_iterations: 1 }) as never);

    const dispatchMessages: BaseMessage[] = mockDispatchingModelInvoke.mock.calls[0][0];

    expect(dispatchMessages).toHaveLength(3);
    expect(dispatchMessages[0].content).toContain("routing decision"); // system prompt
    expect(dispatchMessages[1].content).toBe(BRIEF);                   // the brief, located by type
    expect(dispatchMessages[2]).toBe(assessmentMsg);                   // the assessment itself

    // Nothing from the history leaked in.
    const serialised = JSON.stringify(dispatchMessages.map((m) => m.content));
    expect(serialised).not.toContain("an earlier assessment");
    expect(serialised).not.toContain("an earlier researcher report");
    expect(serialised).not.toContain("an earlier dispatched topic");
  });

  // The complement of the test above: trimming the dispatch call must not trim the assessment
  // call, which needs the notes to judge coverage at all.
  it("still gives the assessment model the full history", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("<Assessment recorded>"));
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "CompleteResearch", id: "tc1", args: {} }]),
    );

    const history = makeHistory();
    await makeSupervisorNode()(makeState({ supervisor_messages: history, research_iterations: 1 }) as never);

    const assessmentMessages: BaseMessage[] = mockFullModelInvoke.mock.calls[0][0];

    expect(assessmentMessages).toHaveLength(history.length + 1); // system prompt + every message
    const serialised = JSON.stringify(assessmentMessages.map((m) => m.content));
    expect(serialised).toContain("an earlier assessment");
    expect(serialised).toContain("an earlier researcher report");
  });

  // The prompt states the turn as a hard limit, so an off-by-one here would tell the model it
  // has a turn it does not have. The counter is incremented in the node's return value, so the
  // turn being dispatched is one past the state it was handed.
  it("tells the dispatch model which turn it is dispatching", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("<Assessment recorded>"));
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "CompleteResearch", id: "tc1", args: {} }]),
    );

    await makeSupervisorNode()(makeState({ research_iterations: 2 }) as never);

    const systemPrompt = mockDispatchingModelInvoke.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toContain("research iteration 3 of 5");
  });

  // A graph seeded without a human message must still route rather than throw: the brief is
  // spread in conditionally, so the call is one message shorter instead of carrying undefined.
  it("dispatches without a brief rather than failing when none is present", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded>");
    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "CompleteResearch", id: "tc1", args: {} }]),
    );

    const result = await makeSupervisorNode()(makeState({ supervisor_messages: [] }) as never);

    const dispatchMessages: BaseMessage[] = mockDispatchingModelInvoke.mock.calls[0][0];
    expect(dispatchMessages).toHaveLength(2);
    expect(dispatchMessages[1]).toBe(assessmentMsg);
    expect(result.goto).toContain("supervisor_tool_node");
  });
});
