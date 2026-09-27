/**
 * LLM-as-judge scoring for the quality of a proposed plan's angles.
 *
 * Not a test file — vitest only collects `*.test.ts`, so this is a plain helper imported
 * by `conversationAgent.eval.test.ts`. It lives apart from the test because the judge
 * prompts are long and the test should read as assertions, not prompt text.
 *
 * ---------------------------------------------------------------------------
 * UNIT OF JUDGEMENT. Genericness and lookup-ness are properties of a SINGLE angle;
 * overlap is a property of a PAIR. An earlier version asked each judge about the whole
 * set ("does EVERY angle pass?") and that collapsed — a strict judge simply faults
 * whichever angle is weakest, so the verdict was near-always NO and carried no
 * information about how many angles were actually bad. When the weakest angle was
 * replaced, the judge moved its objection to a different one. Scoring per angle and per
 * pair is stable, grades rather than gates, and names the offender in the failure output.
 *
 * `intent` stays set-level, because whether the findings answer the user's question is a
 * property of the angles taken together.
 *
 * ---------------------------------------------------------------------------
 * CALIBRATION. These four were calibrated two-sided before being trusted: a deliberately
 * bad plan must be rejected AND a deliberately good one accepted. Getting there took four
 * rounds and every round found a real defect, so do not adjust the wording below casually:
 *
 *   - `researchable` originally asked whether "a plausible one-sentence answer could be
 *     written now". Too weak — a knowledgeable model can always produce a plausible
 *     sentence, so it answered NO to everything. Note this test IS used in
 *     `proposePlanPrompt`, where it works fine: it is a good generator heuristic and a bad
 *     judge criterion, because the generator is trying to satisfy it honestly.
 *   - `intent` first went meta and faulted the USER's question for being open-ended
 *     instead of judging the angles. Later, once angles became specific, it started
 *     demanding a broad "overview" angle — it was judging the angle list as though it were
 *     the report's outline. The paragraph telling it the report is written downstream is
 *     load-bearing; removing it makes every specific plan fail.
 *   - `specific` and `distinct` both had polarity flips, returning NO while their stated
 *     reason argued YES, because an intermediate question primed the opposite polarity
 *     from the final instruction. Hence every judge below states its criterion as prose
 *     and asks exactly one question, at the end, with YES/NO explicitly bound to outcomes.
 *
 * Wording is written from scratch and deliberately shares no examples with
 * `proposePlanPrompt` — copied examples prime a judge toward their specific shape, which
 * is what once made the `scope_topic` nudge judge reject correct output.
 */
import { HumanMessage } from "@langchain/core/messages";
import { miniModel } from "../../src/model.js";

export type Verdict = { verdict: "YES" | "NO" | "UNPARSEABLE"; reason: string };

/**
 * The reason exists for the failure path: `expected 'NO' to be 'YES'` says nothing about
 * why, and re-running to find out costs another round of paid calls.
 */
async function ask(prompt: string): Promise<Verdict> {
  const response = await miniModel.invoke([
    new HumanMessage(
      `${prompt}\n\nAnswer with YES or NO on the first line, then one sentence explaining why on the second line.`,
    ),
  ]);
  const text = (response.content as string).trim();
  const match = /\b(YES|NO)\b/i.exec(text);
  return {
    verdict: match ? (match[1].toUpperCase() as "YES" | "NO") : "UNPARSEABLE",
    reason: text.replace(/^[^\n]*\n?/, "").trim() || text,
  };
}

/** #1 SPECIFIC (not generic) — per angle. The load-bearing judge. */
export const judgeSpecific = (topic: string, angle: string) =>
  ask(`A research angle was proposed for this topic:

Topic: ${topic}
Angle: ${angle}

Apply this test. An angle is ANCHORED when it names at least one particular thing from INSIDE the subject — a named person other than the obvious protagonist, a specific unit, battle, document, order, reform, date-bounded episode, decision or controversy — such that a researcher reading it knows what to go and look up.

An angle is GENERIC when the only thing it names is the subject as a whole. "The Napoleonic Wars", "Napoleon's campaigns", "the conflict" are the subject itself, not particulars within it. An angle at that level is a heading that fits anything and commits the researcher to nothing.

Two cautions:
- A general FRAMING does not make an angle generic. Weighing one cause against another, asking why something failed, contrasting a person with their circumstances — those shapes are available to any subject, and that is fine. What matters is whether the angle names particulars from inside this subject.
- Do not grade on a curve. You are not looking for the least specific angle in some set; you are applying a fixed test to this one angle on its own.

Answer YES if the angle names at least one particular from inside the subject. Answer NO if the only thing it names is the subject as a whole.`);

/** #2 REQUIRES RESEARCH (not a lookup) — per angle. */
export const judgeResearchable = (topic: string, angle: string) =>
  ask(`A research angle was proposed for this topic:

Topic: ${topic}
Angle: ${angle}

Apply this test. An answer is SETTLED when it is simply retrievable — a list, a date, a definition, an inventory, or a summary a reference work would state as established fact. An answer has to be WORKED OUT when it must be assembled from scattered evidence and weighed, and could legitimately come out more than one way, such that informed people could disagree.

Be careful with one thing: the mere fact that a knowledgeable person could produce some plausible-sounding sentence in response is NOT the test. Almost any question permits that. The test is whether the answer is settled and retrievable, or genuinely has to be worked out.

Answer YES if the answer has to be worked out. Answer NO if it is settled and retrievable.`);

/** #3 DISTINCT — per pair. Question-level overlap, which is the definition in use here. */
export const judgeDistinct = (topic: string, a: string, b: string) =>
  ask(`Two research angles were proposed for the same topic. Each goes to a SEPARATE researcher, and their results are combined into one report.

Topic: ${topic}
Angle A: ${a}
Angle B: ${b}

Ignore whether the angles are good or interesting. Judge one thing only: whether these two ask substantially the same question, so that both researchers would cover the same ground and the report would say the same thing twice.

Two angles OVERLAP when one is the other restated in different words, or when one is largely contained inside the other. Two angles are DISTINCT when they examine different aspects of the subject — and they stay distinct even if they share the same topic, the same period, the same battle or the same institution, since examining different aspects of one subject is exactly what a set of angles is for.

Answer YES if the two are distinct. Answer NO if they substantially overlap.`);

/** #4 SERVES THE USER'S INTENT — set level. Also the guard against over-narrowing. */
export const judgeIntent = (question: string, angles: string[]) =>
  ask(`A user asked a research agent this question:

"${question}"

The agent proposed these angles:
${angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Each angle is a research assignment handed to a separate researcher. Their findings are then combined and a single report is written from them. So you are NOT judging whether this list reads like a summary, an outline or a table of contents — you are judging whether the material these assignments would bring back is the material needed to answer the user.

First, decide for yourself what this user wants to come away with — an explanation, a comparison, a judgement, a sense of what something was like, or something else. Commit to one reading; if the question could be read more than one way, take the most natural reading rather than faulting the question for being open.

One reading in particular is a trap. When someone names a subject and asks to research it ("I want to research X"), they are asking for research INTO X. They are NOT demanding a complete chronology or an exhaustive account of X, and you must not treat "it does not narrate everything that happened" as a failure. Going deep on a few well-chosen parts is a legitimate — usually better — way to serve such a request.

Then judge the angles as a set. Three cautions:
- Do NOT require an angle that supplies general background, broad context, an overview, a narrative or a chronology. Breadth comes from the angles covering different parts of the question between them, not from any one of them being broad, and the synthesis is the report's job, not an angle's.
- Do NOT penalise an angle for being narrow, detailed or specific. A narrow assignment that brings back concrete evidence is exactly what research is for. Narrowness is only a problem if the narrow pieces, taken together, are about something other than what the user asked.
- Do NOT fail a set merely because you can think of some further aspect it leaves out. There are only ever a handful of angles; the question is whether what they do cover belongs to the user's question, not whether it exhausts it.

The real test: being about the right SUBJECT is not enough. An angle can be entirely on-subject and still serve a different purpose than the one the user had — answering "what happened" when they asked "why", or examining a person's civil career when the question was about their generalship.

Answer YES if the findings from these angles, taken together, would let a report answer the user's question. Answer NO if they would answer a different, adjacent question and leave theirs unanswered.`);

// ============================================================ SCORING ============================================================

export type Tally = { pass: number; of: number; failures: string[] };

export type Score = {
  specific: Tally;
  researchable: Tally;
  distinct: Tally;
  intent: Verdict;
};

/** Runs every judge over one plan. All calls are issued in parallel. */
export async function scorePlan(topic: string, question: string, angles: string[]): Promise<Score> {
  const pairs: [number, number][] = [];
  for (let i = 0; i < angles.length; i++) {
    for (let j = i + 1; j < angles.length; j++) pairs.push([i, j]);
  }

  const [specifics, researchables, distincts, intent] = await Promise.all([
    Promise.all(angles.map((a) => judgeSpecific(topic, a))),
    Promise.all(angles.map((a) => judgeResearchable(topic, a))),
    Promise.all(pairs.map(([i, j]) => judgeDistinct(topic, angles[i], angles[j]))),
    judgeIntent(question, angles),
  ]);

  const tally = (vs: Verdict[], label: (i: number) => string): Tally => ({
    pass: vs.filter((v) => v.verdict === "YES").length,
    of: vs.length,
    failures: vs.flatMap((v, i) => (v.verdict === "YES" ? [] : [`${label(i)}: ${v.reason}`])),
  });

  return {
    specific: tally(specifics, (i) => `angle ${i + 1}`),
    researchable: tally(researchables, (i) => `angle ${i + 1}`),
    distinct: tally(distincts, (i) => `pair ${pairs[i][0] + 1}-${pairs[i][1] + 1}`),
    intent,
  };
}

/**
 * Logged unconditionally, like the rest of this suite: vitest hides console output from
 * passing tests and prints it when one fails, which is exactly when the judges' reasons
 * are needed.
 */
export function logScore(s: Score) {
  const line = (name: string, t: Tally) => {
    console.log(`  ${name.padEnd(13)}| ${t.pass}/${t.of}`);
    for (const f of t.failures) console.log(`               |   x ${f}`);
  };
  line("specific", s.specific);
  line("researchable", s.researchable);
  line("distinct", s.distinct);
  console.log(`  ${"intent".padEnd(13)}| ${s.intent.verdict}`);
  if (s.intent.verdict !== "YES") console.log(`               |   x ${s.intent.reason}`);
}
