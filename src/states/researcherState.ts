import { z } from "zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { BaseMessage } from "@langchain/core/messages";

export const ResearcherState = z.object({
  researcher_messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
  research_topic: z.string(),
  compressed_research: z.string().default(""),
  raw_notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  research_iterations: withLangGraph(z.number(), { default: () => 0 }),
});

export type ResearcherStateType = z.infer<typeof ResearcherState>;
