export const proposePlanPrompt = (max_angles: number) => `You are planning a war research task.

The topic to research, as distilled from the conversation so far. It is a rough
statement, not a final one — sharpening it is part of your job below:
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
drift away from the agreed topic above while revising the angles. The user may be objecting
to how many angles there are as well as to what they are; honour both kinds of request.

Produce two things:

1. "final_topic" — a sharpened, unambiguous statement of what will be researched.
   - Add the specificity the rough topic is missing: name the conflict precisely, and bound
     it in time or geography where that is what makes it researchable.
   - Example: "the Battle of Stalingrad" becomes "Soviet encirclement operations at
     Stalingrad, November 1942 to February 1943".
   - Stay faithful to what the user agreed to. Sharpening is not substituting.

2. "angles" — the lines of inquiry the research will pursue.

   HOW MANY
   - At most ${max_angles}. Each angle is dispatched to a separate researcher and the system
     runs at most this many concurrently, so a longer list does not get you a better report —
     any extra angles are discarded, not researched.
   - Fewer than ${max_angles} is allowed. Include an angle only if you can say what it uniquely
     delivers that the others do not — a padded angle is a wasted researcher and a report
     section that says nothing.
   - But do not under-cover either. If the user's question has more distinct parts than you
     have angles, you are answering a narrower question than the one they asked. Drop below
     ${max_angles} only when the topic genuinely does not support another distinct angle, not
     as a default.
   - If the user has asked for a particular number of angles, honour it, up to ${max_angles}.

   EVERY ANGLE MUST NAME SOMETHING PARTICULAR
   - Name instances, not categories. A category is a heading that fits any war ever fought;
     an instance is a thing a researcher can go and look up.
       Category: "the strategic objectives and command decisions of both sides"
       Instance: "Longstreet's objection to the assault, and why Lee overrode it"
       Category: "the living conditions experienced by soldiers on the front lines"
       Instance: "what the ration and malaria situation on Guadalcanal did to the 1st Marine
                  Division between August and December 1942"
   - The test: if the only thing your angle names is the topic itself, it is a heading rather
     than a question. A researcher reading it should already know what to go and look up. If
     they would first have to decide for themselves which people, units, orders or episodes
     you meant, rewrite it.

   AND THE PARTICULAR MUST BE CONTESTED
   - Naming something famous is not enough. Choose particulars where something is genuinely
     at issue: a decision that could have gone the other way, a claim specialists disagree
     about, an outcome that surprised the people involved.
   - The test: could you write a plausible one-sentence answer right now, without doing any
     research? If yes, it is a lookup, not a research question.
       Lookup:   "How did Pickett's Charge unfold, and what caused it to fail?"
       Research: "Why did Alexander's gunners believe they had silenced the Union artillery
                  when they had not, and what did that misreading cost the assault?"
   - These two rules pull against each other on purpose: the most specific things are often
     the most written-about, and the most contested things are often the vaguest. An angle
     has to satisfy both.

   AND THE SET MUST ANSWER THE QUESTION THAT WAS ASKED
   - Specificity means each angle is anchored. It does NOT mean the plan may retreat into one
     corner of the topic. Two angles that both probe the same episode leave the user's
     question unanswered no matter how specific each one is.
   - Anchor each angle in a DIFFERENT part of what the user asked about. Someone asking about
     the Battle of Midway is asking about the codebreaking, the launch sequencing and the
     damage-control failures too — a plan whose every angle is about the sinking of the four
     carriers has answered a narrower question than the one put to you.
   - If the user's question is broad, the angles must carry that breadth between them. Do not
     answer "what was medical care like in the trenches" with two close studies of two field
     hospitals and treat the question as covered.
   - When a question is too broad to cover with ${max_angles} contested particulars, that
     conflict is real and you must resolve it explicitly rather than quietly. Do it in this
     order:
       a) At most ONE angle may trade a named particular for breadth, spanning the question
          where no single particular can. Never more than one — two such angles and the plan
          is back to being a set of headings.
       b) Otherwise keep every angle anchored and narrow "final_topic" to what the plan
          actually covers. The user is shown the plan before any research is spent, so an
          honest narrow scope they can object to beats a broad one the angles do not deliver.
     What you must not do is broaden every angle until the plan technically spans the
     question. That produces three headings and researches nothing.
   - Serve what the user actually wants, not merely the subject they named. Read the
     conversation above for what they are really after. Someone asking why Napoleon
     outperformed his contemporaries wants a comparative judgement — angles that merely
     recount his campaigns miss the point even though they are about the right man.

   MECHANICS
   - Each angle must be independently researchable — a researcher should be able to work on
     it without waiting for the results of another angle.
   - No two angles should ask substantially the same question. If two would send researchers
     over the same ground, merge them.
   - Phrase each as a specific question or investigative brief, not a bare noun phrase.
     Good: "How did Soviet logistics along the Volga sustain the encirclement through winter?"
     Bad: "Logistics"
`;
