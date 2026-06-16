import { z } from "zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { BaseMessage } from "@langchain/core/messages";

export const ConversationState = z.object({
  messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
  research_brief: z.string().default(""),
  supervisor_messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
  raw_notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  notes: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => [...a, ...b] },
    default: () => [],
  }),
  final_report: z.string().default(""),
});

export type ConversationStateType = z.infer<typeof ConversationState>;
