import { z } from "zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { BaseMessage } from "@langchain/core/messages";

export const SupervisorState = z.object({
  supervisor_messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
  research_brief: z.string().default(""),
  notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  raw_notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  research_iterations: z.number().default(0),
});

export type SupervisorStateType = z.infer<typeof SupervisorState>;
