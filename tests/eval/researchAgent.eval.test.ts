import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { researchAgent } from "../../src/researchAgent.js";
import { ResearcherStateType } from "../../src/states/researcherState.js";
import { miniModel } from "../../src/model.js";

const RESEARCH_TOPIC =
  "Tactical and doctrinal reasons for linear formations and direct musket fire during the Napoleonic Wars, including command control, communication, and battlefield tactics.";

describe("researchAgent end-to-end eval (real LLM + Tavily)", () => {

  let result: ResearcherStateType;

  beforeAll(async () => {
    result = await researchAgent.invoke({
      research_topic: RESEARCH_TOPIC,
      researcher_messages: [new HumanMessage(RESEARCH_TOPIC)],
    });
  }, 120_000);

  it("produces non-empty compressed research and at least one raw note", () => {
    expect(result.compressed_research.length).toBeGreaterThan(200);
    expect(result.raw_notes.length).toBeGreaterThanOrEqual(1);
  });

  it("compressed research is relevant to the topic (LLM-as-judge)", async () => {
    const judgePrompt = `You are a strict evaluator. A research agent was asked to research the following topic:

"${RESEARCH_TOPIC}"

Here is the compressed research it produced:

---
${result.compressed_research}
---

Does the research substantively address the topic? Consider whether it covers tactical/doctrinal reasons for linear formations, musket fire, command control, communication, and battlefield tactics of the Napoleonic era.

Answer with a single word: YES or NO.`;

    const judgeResponse = await miniModel.invoke([new HumanMessage(judgePrompt)]);
    const verdict = (judgeResponse.content as string).trim().toUpperCase();

    expect(verdict).toBe("YES");
    // console.log("-------- Result fro ssearch);
  }, 30_000);
});
