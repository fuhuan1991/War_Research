import { describe, it, expect, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { makeClarificationNode, ClarificationOutput, ClarificationModel } from "../../src/conversationAgent.js";

// Helper: build a minimal state with one human message
const makeState = (text: string) => ({
  messages: [new HumanMessage(text)],
});

// Helper: build a mock LLM that returns a fixed ClarificationOutput
const makeMockLLM = (output: Partial<typeof ClarificationOutput._type>): ClarificationModel => {
  const fullOutput: typeof ClarificationOutput._type = {
    related: false,
    need_clarification: false,
    reject_reason: "",
    question: "",
    verification: "",
    ...output,
  };
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn().mockResolvedValue(fullOutput),
    }),
  };
};

describe("clarification_node routing", () => {

  it("routes to END with reject_reason when question is not war-related", async () => {
    const llm = makeMockLLM({
      related: false,
      reject_reason: "This question is about trade policy, not a battlefield war.",
    });

    const node = makeClarificationNode(llm);
    const result = await node(makeState("What caused the US-China trade war?"));

    expect(result.goto).toContain(END);
    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toBe(
      "This question is about trade policy, not a battlefield war."
    );
  });

  it("routes to END with a clarifying question when question is war-related but unclear", async () => {
    const llm = makeMockLLM({
      related: true,
      need_clarification: true,
      question: "Could you specify which Middle East conflict you are referring to?",
    });

    const node = makeClarificationNode(llm);
    const result = await node(makeState("Tell me about the war in the Middle East."));

    expect(result.goto).toContain(END);
    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toBe(
      "Could you specify which Middle East conflict you are referring to?"
    );
  });

  it("routes to briefing_node with verification when question is war-related and clear", async () => {
    const llm = makeMockLLM({
      related: true,
      need_clarification: false,
      verification: "Understood. I will now research the Battle of Stalingrad.",
    });

    const node = makeClarificationNode(llm);
    const result = await node(makeState("What were the key turning points of the Battle of Stalingrad?"));

    expect(result.goto).toContain("briefing_node");
    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toBe(
      "Understood. I will now research the Battle of Stalingrad."
    );
  });

});
