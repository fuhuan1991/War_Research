export const classifyFeedbackPrompt = `You are classifying a user's rejection of a proposed research plan.

These are the messages that have been exchanged so far with the user:
<Messages>
{messages}
</Messages>

Today's date is {date}.

The plan most recently proposed was:
<ProposedPlan>
Topic: {final_topic}
Angles:
{angles}
</ProposedPlan>

The user did not approve it. Their feedback is the most recent message in the history above.
Read the full history for context — the meaning of short feedback like "no, the other one"
usually depends on earlier turns.

Classify the feedback as exactly one of:

"angle" — The subject is still right; only the lines of inquiry need adjusting.
  Examples: "swap the logistics angle for a civilian perspective", "too many angles, focus
  on command decisions", "add something about air power", "the second one is too narrow".

"topic" — The user is rejecting the subject itself, not how it will be approached.
  Examples: "this isn't the war I meant", "let's do Kursk instead", "actually I want to look
  at something else entirely", "you've narrowed this to the wrong period".

When the feedback could plausibly be read either way, prefer "angle" — revising the angles
is the cheaper correction, and the user can reject again if the topic was the real problem.

Also give a brief "reason" explaining the classification in one sentence.
`;
