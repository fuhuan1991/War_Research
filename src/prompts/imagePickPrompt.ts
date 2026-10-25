/**
 * Call B of the illustration pass: choose among the candidates Commons returned.
 *
 * This call exists because Commons' relevance ranking is literal and top-1 is not safe. The
 * measured example that justifies the spend: the query "Prokhorovka tank battle" ranked a
 * tourist photograph of a bird nesting in a gun barrel first, and two photographs of the
 * modern Zvonnitsa memorial above any image of the 1943 fighting.
 *
 * Maps were originally on the REJECT list here ("a map is not an illustration of a battle's
 * character"). That was wrong for this project: for a section about movement, terrain or the
 * phases of a fight, a map shows more than any painting. They are now preferred for exactly
 * those sections and capped at one per section, because Commons returns maps in abundance and
 * ranks them highly — "Gettysburg battle map" comes back as nothing but maps.
 *
 * The model returns candidate NUMBERS, never URLs. A model that types a URL types a plausible
 * one, and a plausible-but-wrong image URL is a broken image in a finished report.
 */
export const imagePickPrompt = `You are selecting which pictures to place in a finished history report about war.

Below are the report's sections. Under each section are the images Wikimedia Commons returned for it, each with a number, its title, its pixel dimensions and its artist or creator where known.

<Candidates>
{candidates}
</Candidates>

For each section, choose up to {max_per_section} images, in the order they should appear.

PREFER:
- a period painting, engraving or print of the event itself
- a clear photograph of the actual weapon, uniform, ship or vehicle
- a museum object or archaeological relic, photographed against a plain background
- a documentary photograph taken at the time of the events
- a battle or campaign map, when the section discusses movement, terrain, positions, the
  phases of the fighting or the course of a campaign — for those a map often shows more than
  any painting can

REJECT — these come back often and are almost always wrong:
- modern memorials, monuments, war cemeteries and commemorative sculpture (unless the section is itself about commemoration)
- re-enactments, living-history displays, and film or video-game imagery
- casual tourist snapshots, and photographs where the subject is incidental to the shot
- book covers, title pages, stamps, coins and medals, unless the section is about that object
- portraits of people the section does not discuss
- a modern road map, a satellite view, or a world map with a dot marking where something happened — these show nothing about the fighting
- a map, when the section is about a person, an object, a decision or a consequence rather than about ground, movement or position
- a translated copy of a map when an English or untitled version of the same map is also listed. Commons holds the same map in many languages and each is a separate entry, so titles ending in a language tag — "cs", "ita", "rus", "heb", "ar", "(french)" — are duplicates of a map you can already choose
- images whose title suggests a different war, a different place, or a different century from the section

Other rules:
1. Never choose the same image for two different sections.
2. At most ONE map per section, and do not make the whole report maps. Commons returns maps in
   abundance and ranks them highly — a single query can come back as nothing but maps — so a
   map competes with the painting, weapon or photograph that would otherwise sit beside it.
3. Larger dimensions are a weak signal of a better scan, but relevance beats size every time.
4. Choose FEWER images, or none at all, if nothing in a section's list genuinely depicts its subject. An empty list is a correct answer and a wrong picture is not. Do not fill a quota.
5. For each image you choose, write a short alt text: a plain description of what the picture shows, under 15 words, with no commentary. The file's own title is often a catalogue number and makes poor alt text.

Return every section number you were given, each with its chosen images (possibly none).`;
