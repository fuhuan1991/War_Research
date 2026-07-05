import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockFullModelInvoke, mockDispatchingModelInvoke, mockTavilySearch } = vi.hoisted(() => ({
  mockFullModelInvoke: vi.fn(),
  mockDispatchingModelInvoke: vi.fn(),
  mockTavilySearch: vi.fn(),
}));

vi.mock("../../src/model.js", () => ({
  fullModel: { invoke: mockFullModelInvoke },
  // dispatchingModel is created via nanoModel.bindTools(...) at module load time
  nanoModel: {
    bindTools: () => ({ invoke: mockDispatchingModelInvoke }),
  },
}));

vi.mock("../../src/tools/tavilySearch.js", () => ({
  executeTavilySearch: mockTavilySearch,
}));

vi.mock("../../src/config.js", () => ({
  MAX_RESEARCHER_TURNS: 5,
  MAX_CONCURRENT_TAVILY_SEARCHES: 4,
}));

import { makeResearchNode, makeResearchToolNode, makeCompressionNode } from "../../src/researchAgent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<{
  researcher_messages: (HumanMessage | AIMessage | ToolMessage)[];
  research_topic: string;
  research_iterations: number;
  compressed_research: string;
  raw_notes: string[];
}> = {}) {
  return {
    researcher_messages: [],
    research_topic: "Battle of Stalingrad",
    research_iterations: 0,
    compressed_research: "",
    raw_notes: [],
    ...overrides,
  };
}

function makeAIMessage(toolCalls: { name: string; id: string; args: Record<string, unknown> }[]): AIMessage {
  return new AIMessage({ content: "", tool_calls: toolCalls });
}

// ---------------------------------------------------------------------------
// makeResearchNode
// ---------------------------------------------------------------------------

describe("makeResearchNode", () => {

  beforeEach(() => vi.clearAllMocks());

  it("goes to compression_node without calling any model when turn limit is reached", async () => {
    const node = makeResearchNode();
    const result = await node(makeState({ research_iterations: 5 }));

    expect(mockFullModelInvoke).not.toHaveBeenCalled();
    expect(mockDispatchingModelInvoke).not.toHaveBeenCalled();
    expect(result.goto).toContain("compression_node");
  });

  it("calls both models and goes to research_tool_node when under the turn limit", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded> need more data");
    const dispatchMsg = makeAIMessage([{ name: "TavilySearch", id: "tc1", args: { query: "stalingrad tactics" } }]);

    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(dispatchMsg);

    const node = makeResearchNode();
    const result = await node(makeState({ research_iterations: 0 }));

    expect(mockFullModelInvoke).toHaveBeenCalledOnce();
    expect(mockDispatchingModelInvoke).toHaveBeenCalledOnce();
    expect(result.goto).toContain("research_tool_node");
  });

  it("appends both AI messages and increments research_iterations", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded> done");
    const dispatchMsg = makeAIMessage([{ name: "TavilySearch", id: "tc1", args: { query: "stalingrad" } }]);

    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(dispatchMsg);

    const node = makeResearchNode();
    const result = await node(makeState({ research_iterations: 2 }));

    expect(result.update.researcher_messages).toEqual([assessmentMsg, dispatchMsg]);
    expect(result.update.research_iterations).toBe(3);
  });

  it("still routes to research_tool_node even when dispatching returns CompleteSearch", async () => {
    // Routing based on CompleteSearch is handled by the tool node, not this node
    const assessmentMsg = new AIMessage("<Assessment recorded> complete");
    const dispatchMsg = makeAIMessage([{ name: "CompleteSearch", id: "tc2", args: {} }]);

    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(dispatchMsg);

    const node = makeResearchNode();
    const result = await node(makeState({ research_iterations: 1 }));

    expect(result.goto).toContain("research_tool_node");
  });
});

// ---------------------------------------------------------------------------
// makeResearchToolNode
// ---------------------------------------------------------------------------

describe("makeResearchToolNode", () => {

  beforeEach(() => vi.clearAllMocks());

  it("goes to compression_node and acks all calls when CompleteSearch is present", async () => {
    const lastMsg = makeAIMessage([
      { name: "CompleteSearch", id: "tc-done", args: {} },
    ]);

    const node = makeResearchToolNode();
    const result = await node(makeState({ researcher_messages: [lastMsg] }));

    expect(mockTavilySearch).not.toHaveBeenCalled();
    expect(result.goto).toContain("compression_node");

    const toolMessages: ToolMessage[] = result.update.researcher_messages;
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe("<Research completed>");
    expect(toolMessages[0].tool_call_id).toBe("tc-done");
  });

  it("acks all tool calls with '<Research completed>' when CompleteSearch is mixed with TavilySearch", async () => {
    const lastMsg = makeAIMessage([
      { name: "TavilySearch", id: "tc-s1", args: { query: "tanks" } },
      { name: "CompleteSearch", id: "tc-done", args: {} },
    ]);

    const node = makeResearchToolNode();
    const result = await node(makeState({ researcher_messages: [lastMsg] }));

    expect(mockTavilySearch).not.toHaveBeenCalled();
    expect(result.goto).toContain("compression_node");

    const toolMessages: ToolMessage[] = result.update.researcher_messages;
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.every((m) => m.content === "<Research completed>")).toBe(true);
  });

  it("executes TavilySearch calls and goes to research_node", async () => {
    mockTavilySearch.mockResolvedValueOnce("result A");
    mockTavilySearch.mockResolvedValueOnce("result B");

    const lastMsg = makeAIMessage([
      { name: "TavilySearch", id: "tc-1", args: { query: "query A" } },
      { name: "TavilySearch", id: "tc-2", args: { query: "query B" } },
    ]);

    const node = makeResearchToolNode();
    const result = await node(makeState({ researcher_messages: [lastMsg] }));

    expect(mockTavilySearch).toHaveBeenCalledTimes(2);
    expect(mockTavilySearch).toHaveBeenCalledWith("query A");
    expect(mockTavilySearch).toHaveBeenCalledWith("query B");
    expect(result.goto).toContain("research_node");

    const toolMessages: ToolMessage[] = result.update.researcher_messages;
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].content).toBe("result A");
    expect(toolMessages[1].content).toBe("result B");
  });

  it("skips calls beyond MAX_CONCURRENT_TAVILY_SEARCHES (4) with a skip message", async () => {
    // 5 calls, limit is 4 — the 5th should be skipped
    mockTavilySearch.mockResolvedValue("search result");

    const calls = [1, 2, 3, 4, 5].map((n) => ({
      name: "TavilySearch",
      id: `tc-${n}`,
      args: { query: `query ${n}` },
    }));
    const lastMsg = makeAIMessage(calls);

    const node = makeResearchToolNode();
    const result = await node(makeState({ researcher_messages: [lastMsg] }));

    expect(mockTavilySearch).toHaveBeenCalledTimes(4);
    expect(result.goto).toContain("research_node");

    const toolMessages: ToolMessage[] = result.update.researcher_messages;
    expect(toolMessages).toHaveLength(5);
    expect(toolMessages[4].content).toBe("<Search skipped: concurrent search limit reached>");
    expect(toolMessages[4].tool_call_id).toBe("tc-5");
  });
});

// ---------------------------------------------------------------------------
// makeCompressionNode
// ---------------------------------------------------------------------------

describe("makeCompressionNode", () => {

  beforeEach(() => vi.clearAllMocks());

  it("returns compressed_research from the model response", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("Compressed findings."));

    const node = makeCompressionNode();
    const result = await node(makeState({ researcher_messages: [] }));

    expect(result.compressed_research).toBe("Compressed findings.");
  });

  it("collects real search ToolMessages into raw_notes", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("summary"));

    const messages = [
      new ToolMessage({ content: "Real search result 1", name: "TavilySearch", tool_call_id: "t1" }),
      new ToolMessage({ content: "Real search result 2", name: "TavilySearch", tool_call_id: "t2" }),
    ];

    const node = makeCompressionNode();
    const result = await node(makeState({ researcher_messages: messages }));

    expect(result.raw_notes).toEqual(["Real search result 1", "Real search result 2"]);
  });

  it("excludes synthetic control messages (starting with '<') from raw_notes", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("summary"));

    const messages = [
      new ToolMessage({ content: "Real search result", name: "TavilySearch", tool_call_id: "t1" }),
      new ToolMessage({ content: "<Research completed>", name: "CompleteSearch", tool_call_id: "t2" }),
      new ToolMessage({ content: "<Search skipped: concurrent search limit reached>", name: "TavilySearch", tool_call_id: "t3" }),
    ];

    const node = makeCompressionNode();
    const result = await node(makeState({ researcher_messages: messages }));

    expect(result.raw_notes).toEqual(["Real search result"]);
  });

  it("returns empty raw_notes when there are no ToolMessages", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("summary"));

    const messages = [
      new HumanMessage("What happened at Stalingrad?"),
      new AIMessage("<Assessment recorded> nothing yet"),
    ];

    const node = makeCompressionNode();
    const result = await node(makeState({ researcher_messages: messages }));

    expect(result.raw_notes).toEqual([]);
  });

  it("passes the research_topic into the human message sent to the model", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("summary"));

    const node = makeCompressionNode();
    await node(makeState({ research_topic: "Kursk tank battle", researcher_messages: [] }));

    const callArgs = mockFullModelInvoke.mock.calls[0][0];
    const humanMsg = callArgs[callArgs.length - 1];
    expect(humanMsg.content).toContain("Kursk tank battle");
  });
});
