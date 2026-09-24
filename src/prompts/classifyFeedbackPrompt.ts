export const classifyFeedbackPrompt = `You are classifying a user's reply to a proposed research plan.

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

The user was asked whether the plan looks right, and invited to approve it or say what to
change. Their reply is the most recent message in the history above. Read the full history
for context — the meaning of a short reply like "no, the other one" usually depends on
earlier turns.

Classify the reply as exactly one of:

"approve" — The user is accepting the plan as it stands and wants research to begin.
  Examples: "approve", "correct", "looks good", "yes", "go ahead", "that's right, start",
  "perfect, run it".
  Note that an approval can arrive alongside a compliment or a thank-you; what matters is
  that the user is asking for nothing to be changed.

"angle" — The subject is still right; only the lines of inquiry need adjusting.
  Examples: "swap the logistics angle for a civilian perspective", "too many angles, focus
  on command decisions", "add something about air power", "the second one is too narrow".

"topic" — The user is rejecting the subject itself, not how it will be approached.
  Examples: "this isn't the war I meant", "let's do Kursk instead", "actually I want to look
  at something else entirely", "you've narrowed this to the wrong period".

Only choose "approve" when the reply is genuinely an acceptance. A reply that approves *and*
requests a change ("looks good, but drop angle 3") is NOT an approval — classify it by the
change being asked for. If you are unsure whether the user is accepting or asking for
something, do not choose "approve".

When the reply is clearly not an approval but could plausibly be read as either "angle" or
"topic", prefer "angle" — revising the angles is the cheaper correction, and the user can
reject again if the topic was the real problem.

Also give a brief "reason" explaining the classification in one sentence.
`;
