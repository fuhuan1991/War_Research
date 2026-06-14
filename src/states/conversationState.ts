import { MessagesAnnotation, Annotation, messagesStateReducer } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

// Annotation is a field descriptor that bundles together a field's type and its reducer (the merge function).

export const ConversationState = Annotation.Root({
  ...MessagesAnnotation.spec,
  research_brief: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  supervisor_messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  raw_notes: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  notes: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  final_report: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});
