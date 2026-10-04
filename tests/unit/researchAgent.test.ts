import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

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
  seen_urls: string[];
}> = {}) {
  return {
    researcher_messages: [],
    research_topic: "Battle of Stalingrad",
    research_iterations: 0,
    compressed_research: "",
    raw_notes: [],
    seen_urls: [],
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

  it("puts the research topic into both system prompts", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("<Assessment recorded> ok"));
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "TavilySearch", id: "tc1", args: { query: "q" } }]),
    );

    const node = makeResearchNode();
    await node(makeState({ research_topic: "Siege of Leningrad logistics" }));

    const assessmentSystem = mockFullModelInvoke.mock.calls[0][0][0].content as string;
    const dispatchSystem = mockDispatchingModelInvoke.mock.calls[0][0][0].content as string;

    expect(assessmentSystem).toContain("Siege of Leningrad logistics");
    expect(dispatchSystem).toContain("Siege of Leningrad logistics");
  });

  // fillTemplate deliberately leaves unknown slots untouched so a typo stays visible in the
  // prompt. That makes a mistyped key degrade silently back to never passing the topic at
  // all, which is the bug this whole change fixes — so assert the slot is really gone.
  it("leaves no unfilled {topic} slot in either system prompt", async () => {
    mockFullModelInvoke.mockResolvedValueOnce(new AIMessage("<Assessment recorded> ok"));
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "TavilySearch", id: "tc1", args: { query: "q" } }]),
    );

    const node = makeResearchNode();
    await node(makeState());

    const assessmentSystem = mockFullModelInvoke.mock.calls[0][0][0].content as string;
    const dispatchSystem = mockDispatchingModelInvoke.mock.calls[0][0][0].content as string;

    expect(assessmentSystem).not.toContain("{topic}");
    expect(dispatchSystem).not.toContain("{topic}");
  });

  it("throws instead of researching blind when research_topic is blank", async () => {
    const node = makeResearchNode();

    await expect(node(makeState({ research_topic: "   " }))).rejects.toThrow(/research_topic/);
    expect(mockFullModelInvoke).not.toHaveBeenCalled();
    expect(mockDispatchingModelInvoke).not.toHaveBeenCalled();
  });

  // The dispatch model is deliberately given no message history: it only has to name a tool,
  // and the assessment it receives already states the decision. Spreading `...messages` into
  // it cost 157k nano input tokens across six measured traces to produce 711 output tokens.
  // Nothing else in this file pins that call's message array, so without this test the spread
  // can come back unnoticed and silently restore the cost.
  it("sends the dispatch model only the system prompt, the topic and the assessment", async () => {
    const assessmentMsg = new AIMessage("<Assessment recorded> search for the next gap");
    mockFullModelInvoke.mockResolvedValueOnce(assessmentMsg);
    mockDispatchingModelInvoke.mockResolvedValueOnce(
      makeAIMessage([{ name: "TavilySearch", id: "tc1", args: { query: "q" } }]),
    );

    // Long enough that a spread would be unmistakable.
    const history = [
      new HumanMessage("Battle of Stalingrad"),
      new AIMessage("<Assessment recorded> an earlier assessment"),
      makeAIMessage([{ name: "TavilySearch", id: "old-1", args: { query: "an earlier query" } }]),
      new ToolMessage({
        content: "--- SOURCE 1: an earlier search result ---",
        name: "TavilySearch",
        tool_call_id: "old-1",
      }),
    ];

    const node = makeResearchNode();
    await node(makeState({ researcher_messages: history, research_iterations: 1 }));

    const dispatchMessages: BaseMessage[] = mockDispatchingModelInvoke.mock.calls[0][0];

    expect(dispatchMessages).toHaveLength(3);
    expect(dispatchMessages[0].content).toContain("Battle of Stalingrad");  // system prompt
    expect(dispatchMessages[1].content).toBe("Battle of Stalingrad");       // topic, rebuilt
    expect(dispatchMessages[2]).toBe(assessmentMsg);                        // the assessment itself

    // Nothing from the history leaked in.
    const serialised = JSON.stringify(dispatchMessages.map((m) => m.content));
    expect(serialised).not.toContain("an earlier assessment");
    expect(serialised).not.toContain("an earlier search result");
    expect(dispatchMessages.some((m) => m.getType() === "tool")).toBe(false);

    // The assessment model, by contrast, must still receive the whole history — this change
    // is about what the dispatch call reads, not about trimming state.
    const assessmentMessages: BaseMessage[] = mockFullModelInvoke.mock.calls[0][0];
    expect(assessmentMessages).toHaveLength(1 + history.length);
    expect(assessmentMessages.some((m) => m.getType() === "tool")).toBe(true);
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
    expect(mockTavilySearch).toHaveBeenCalledWith("query A", expect.any(Set));
    expect(mockTavilySearch).toHaveBeenCalledWith("query B", expect.any(Set));
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
// makeResearchToolNode — run-level URL dedupe
//
// The node owns the seen-URL set for a turn: it seeds one from state and hands that single
// instance to every parallel search, then writes back only what the turn added. Both halves
// matter and neither fails loudly if broken — a fresh set per call silently restores
// intra-turn duplication, and writing the whole union silently grows state quadratically
// because the channel's reducer appends.
// ---------------------------------------------------------------------------

describe("makeResearchToolNode — run-level URL dedupe", () => {
  it("seeds the set from seen_urls so a later turn does not re-summarise an earlier turn's page", async () => {
    mockTavilySearch.mockResolvedValue("result");

    const lastMsg = makeAIMessage([
      { name: "TavilySearch", id: "tc-1", args: { query: "query A" } },
    ]);

    const node = makeResearchToolNode();
    await node(makeState({
      researcher_messages: [lastMsg],
      seen_urls: ["https://example.com/earlier"],
    }));

    const seen = mockTavilySearch.mock.calls[0][1] as Set<string>;
    expect(seen.has("https://example.com/earlier")).toBe(true);
  });

  it("hands every parallel search the same set instance, so two of them cannot both summarise one page", async () => {
    mockTavilySearch.mockResolvedValue("result");

    const lastMsg = makeAIMessage([
      { name: "TavilySearch", id: "tc-1", args: { query: "query A" } },
      { name: "TavilySearch", id: "tc-2", args: { query: "query B" } },
      { name: "TavilySearch", id: "tc-3", args: { query: "query C" } },
    ]);

    const node = makeResearchToolNode();
    await node(makeState({ researcher_messages: [lastMsg] }));

    const sets = mockTavilySearch.mock.calls.map((c: unknown[]) => c[1]);
    expect(sets).toHaveLength(3);
    // Identity, not equality: a fresh empty set per call would pass a deep-equality check and
    // leave the intra-turn duplication exactly as it was.
    expect(sets[1]).toBe(sets[0]);
    expect(sets[2]).toBe(sets[0]);
  });

  it("writes back only the URLs the turn added, not the whole union", async () => {
    // Mimics the real executeTavilySearch, which claims each page it summarises.
    mockTavilySearch.mockImplementation(async (query: string, seen: Set<string>) => {
      seen.add(`https://example.com/${query}`);
      return "result";
    });

    const lastMsg = makeAIMessage([
      { name: "TavilySearch", id: "tc-1", args: { query: "new-a" } },
      { name: "TavilySearch", id: "tc-2", args: { query: "new-b" } },
    ]);

    const node = makeResearchToolNode();
    const result = await node(makeState({
      researcher_messages: [lastMsg],
      seen_urls: ["https://example.com/old"],
    }));

    expect(result.update.seen_urls).toEqual([
      "https://example.com/new-a",
      "https://example.com/new-b",
    ]);
    expect(result.update.seen_urls).not.toContain("https://example.com/old");
  });

  it("writes no seen_urls on the CompleteSearch path, where nothing was searched", async () => {
    const lastMsg = makeAIMessage([{ name: "CompleteSearch", id: "tc-1", args: {} }]);

    const node = makeResearchToolNode();
    const result = await node(makeState({ researcher_messages: [lastMsg] }));

    expect(result.goto).toContain("compression_node");
    expect(result.update.seen_urls).toBeUndefined();
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
