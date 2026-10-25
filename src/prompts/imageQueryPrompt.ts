/**
 * Call A of the illustration pass: turn the finished report's sections into Commons search
 * queries, grounded in what the research actually found.
 *
 * The grounding is the whole point of running this after research rather than from the
 * approved plan. A plan angle may ask "what was the secret weapon at X"; the findings are
 * what reveal the answer was a Puckle gun, and "Puckle gun" is the query that returns a
 * photograph of one. The angle's own words never would.
 *
 * The 2-4 keyword rule is measured, not stylistic — see note 1 in
 * `src/images/commonsImages.ts`. Commons' search is effectively conjunctive, so a
 * natural-language phrase returns nothing at all even for a well-documented subject.
 */
export const imageQueryPrompt = `You are choosing illustrations for a finished history report about war.

Today's date is {date}.

Below are the report's sections, each with a number, and the research findings the report was written from.

<Sections>
{sections}
</Sections>

<Findings>
{findings}
</Findings>

For each section, write up to {max_queries} search queries for Wikimedia Commons. Good pictures for a war report are:
- a period painting or engraving of the battle, siege or campaign
- the actual weapon, ship, aircraft or vehicle involved
- an object or relic held in a museum
- a documentary photograph taken at the time
- a map of the battlefield or the campaign, for a section about ground, movement or position

CRITICAL — how to write a query. Wikimedia Commons matches ALL the words you give it, so a sentence finds nothing. Name the thing in 2 to 4 words, the way a museum label would.
- GOOD: "Puckle gun"
- GOOD: "Prokhorovka 1943"
- GOOD: "Brown Bess musket"
- GOOD: "Battle of Austerlitz painting"
- GOOD: "Gettysburg battle map"
- GOOD: "Waterloo campaign map"
- BAD: "the secret weapon used at the siege" (describes, names nothing)
- BAD: "Prokhorovka tank engagement July 1943" (too many words — returns zero results)
- BAD: "soldiers in the trenches" (generic; could be any war)

Other rules:
1. Name what the FINDINGS revealed, not what the section heading asks. If the heading poses a question and the findings answer it, query the answer.
2. Prefer proper nouns — a person, a place, a named weapon, a named ship, a dated battle. A query with no proper noun usually returns something generic.
3. Vary the kind of picture across sections. A report where every section shows an oil painting is worse than one that shows a painting, then a weapon, then a photograph.
4. Ask for a map only where one would actually help — a section about ground, movement, positions or the phases of a fight. Do not ask every section for a map: maps are plentiful and rank highly, so a report can easily end up as nothing but maps. One map in a report is usually right, two is the most that is ever useful.
5. If a section cannot be illustrated — it is an introduction, a conclusion, a discussion of historiography, or simply too abstract — return an empty query list for it. An irrelevant picture is worse than no picture.
6. Use the same language for queries as the source material's own naming, which for Wikimedia Commons is usually English.

Return every section number you were given, each with its list of queries (possibly empty).`;
