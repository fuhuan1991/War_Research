import { MessagesAnnotation, Annotation } from "@langchain/langgraph";

// Annotation is a field descriptor that bundles together a field's type and its reducer (the merge function).

export const ConversationState = Annotation.Root({
  ...MessagesAnnotation.spec,
  research_brief: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});
