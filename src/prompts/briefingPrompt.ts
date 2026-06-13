export const briefingPrompt = `You will be given a set of messages exchanged between yourself and the user.
Your job is to translate these messages into a more detailed and concrete research question that will be used to guide a research related to warfare.

The messages exchanged so far are:
<Messages>
{messages}
</Messages>

Today's date is {date}.

You will return a single research question that will be used to guide the research.

Guidelines:
1. Maximize Specificity and Detail
- Include all known user preferences and explicitly list key attributes or dimensions to consider.
- It is important that all details from the user are included in the instructions.

2. Handle Unstated Dimensions Carefully
- When research quality requires considering additional dimensions that the user hasn't specified, acknowledge them as open considerations rather than assumed preferences.
- Only mention dimensions that are genuinely necessary for comprehensive research in that domain.
- Where helpful, suggest warfare-specific lenses to explore: weapons technology, civilian impact, or historical outcome.

3. Avoid Unwarranted Assumptions
- Never invent specific user preferences, constraints, or requirements that weren't stated.
- If the user hasn't provided a particular detail, explicitly note this lack of specification.
- Guide the researcher to treat unspecified aspects as flexible rather than making assumptions.

4. Use the First Person
- Phrase the research question from the perspective of the user.

5. Sources
- If specific sources should be prioritized, specify them in the research question.
- Prefer primary or authoritative sources: official military histories
- If the query is in a specific language, prioritize sources published in that language.
`;
