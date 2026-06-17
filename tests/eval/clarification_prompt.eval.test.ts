import "dotenv/config";
import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { model, makeClarificationNode } from "../../src/conversationAgent.js";

const node = makeClarificationNode(model);

const makeState = (...messages: (HumanMessage | AIMessage)[]) => ({ messages });

describe("clarification prompt evaluation (real LLM)", () => {

  // --- Rejection: completely unrelated ---

  it("rejects a question with no connection to war", async () => {
    const result = await node(makeState(new HumanMessage("What is the best pasta recipe?")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  // --- Rejection: metaphorical war ---

  it("rejects a trade war question", async () => {
    const result = await node(makeState(new HumanMessage("What caused the US-China trade war?")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("rejects a culture war question", async () => {
    const result = await node(makeState(new HumanMessage("How should I fight my culture war on social media?")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("rejects a war on drugs question", async () => {
    const result = await node(makeState(new HumanMessage("Was the war on drugs effective?")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  // --- Clarification needed ---

  it("asks for clarification when the question is too vague", async () => {
    const result = await node(makeState(new HumanMessage("Tell me about a war.")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("asks for clarification when the conflict is ambiguous", async () => {
    const result = await node(makeState(new HumanMessage("Tell me about the war in the Middle East.")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("asks for clarification when the topic covers multiple distinct conflicts", async () => {
    const result = await node(makeState(new HumanMessage("I want to know more about the Punic War.")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  // --- Focus gathering needed ---

  it("asks a focus question when the topic is broad but unambiguous", async () => {
    const result = await node(makeState(new HumanMessage("I want to know more about WWII.")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("asks a focus question when the topic is broad", async () => {
    const result = await node(makeState(new HumanMessage("Tell me about the Vietnam War.")));
    expect(result.goto).toContain(END);
    expect(result.update.messages[0].content).toBeTruthy();
  });

  // --- No clarification or focus needed: proceed to research ---

  it("proceeds when the question is specific enough", async () => {
    const result = await node(makeState(new HumanMessage("What were the key turning points of the Battle of Stalingrad?")));
    expect(result.goto).toContain("briefing_node");
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("proceeds when the conflict and scope are both clear", async () => {
    const result = await node(makeState(new HumanMessage("Compare the tank strategies used by both sides in the Six-Day War.")));
    expect(result.goto).toContain("briefing_node");
    expect(result.update.messages[0].content).toBeTruthy();
  });

  it("proceeds when the user has already specified a focus on a broad topic", async () => {
    const result = await node(makeState(new HumanMessage("I want to know about WWII tank warfare on the Eastern Front.")));
    expect(result.goto).toContain("briefing_node");
    expect(result.update.messages[0].content).toBeTruthy();
  });

  // --- Multi-turn: should NOT ask a second clarifying question ---

  it("does not ask a second clarifying question after the user has already answered", async () => {
    const result = await node(makeState(
      new HumanMessage("Tell me about the war in the Middle East."),
      new AIMessage("Could you specify which Middle East conflict you are referring to?"),
      new HumanMessage("I mean the 1973 Yom Kippur War."),
    ));
    expect(result.goto).toContain("briefing_node");
  });

  it("does not ask a second focus question after the user has already provided a focus", async () => {
    const result = await node(makeState(
      new HumanMessage("I want to know more about WWII."),
      new AIMessage("Which dimension interests you most? For example: major battles, military strategy, soldier experience, technology, or civilian impact?"),
      new HumanMessage("I'm most interested in the Western Front."),
    ));
    expect(result.goto).toContain("briefing_node");
  });

});
