export const proposePlanPrompt = `You are planning a war research task.

The topic the user has agreed to is:
<Topic>
{topic}
</Topic>

These are the messages that have been exchanged so far with the user:
<Messages>
{messages}
</Messages>

Today's date is {date}.

Your job is to turn the agreed topic into a concrete research plan that the user will be
shown and asked to approve.

IMPORTANT: the message history may already contain a plan you proposed earlier along with
the user's criticism of it. If so, this is a REVISION — read that feedback carefully and
address it directly. Do not re-propose something the user has already rejected, and do not
drift away from the agreed topic above while revising the angles.

Produce two things:

1. "final_topic" — a sharpened, unambiguous statement of what will be researched.
   - Add the specificity the rough topic is missing: name the conflict precisely, and bound
     it in time or geography where that is what makes it researchable.
   - Example: "the Battle of Stalingrad" becomes "Soviet encirclement operations at
     Stalingrad, November 1942 to February 1943".
   - Stay faithful to what the user agreed to. Sharpening is not substituting.

2. "angles" — the distinct lines of inquiry the research will pursue.
   - Produce between 3 and 5 angles. Never more than 5. Each one will be dispatched to a
     separate researcher, and the system runs a limited number of them concurrently, so a
     long list does not get you a better report.
   - Each angle must be independently researchable — a researcher should be able to work on
     it without waiting for the results of another angle.
   - Angles must not overlap. If two angles would surface the same sources, merge them.
   - Phrase each as a specific question or investigative brief, not a bare noun phrase.
     Good: "How did Soviet logistics along the Volga sustain the encirclement through winter?"
     Bad: "Logistics"
   - Where useful, draw on warfare-specific lenses: strategy and command decisions, weapons
     and technology, logistics and supply, intelligence, civilian impact, or the outcome's
     longer-term consequences. Pick the ones that genuinely fit this conflict.
`;
