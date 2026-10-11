/**
 * A tracing harness for `supervisorAgent`, built for analysis. It is not part of the pipeline
 * and nothing in `src/` imports it.
 *
 * It is the sibling of `traceResearcher.ts` and works the same way — stream the graph for
 * state deltas, wrap `invoke` on the model singletons for the LLM calls (both mechanisms live
 * in `traceCommon.ts`) — but the supervisor differs from the researcher in three ways that
 * shape this file:
 *
 *   1. **It spawns real researchers.** `supervisor_tool_node` calls `researchAgent.invoke()`
 *      up to MAX_CONCURRENT_RESEARCH_UNITS times per turn, for as many turns as it takes. One
 *      traced run is therefore the most expensive thing in this repo — each spawned
 *      researcher is roughly one `npm run trace:researcher`.
 *   2. **Those researchers are invisible to the stream.** `researchAgent` is invoked *inside*
 *      a node rather than wired in as a subgraph node, and no config is threaded through, so
 *      no `streamMode`/`subgraphs` setting can see into it. This harness deliberately does
 *      not patch `researchAgent` either: it reports what the supervisor itself sees, which is
 *      the dispatched topic going in and the `compressed_research` string coming back.
 *   3. **Every researcher's LLM calls land in the same singletons.** The patch records every
 *      call in the process, so without attribution the supervisor's own two-per-turn calls
 *      are buried in a hundred researcher calls. Each call is therefore tagged with its
 *      caller, identified from the prompt it sent (see MARKERS below), which is what makes
 *      the supervisor-spend-versus-researcher-spend split in summary.md possible.
 *
 * The entry point mirrors production exactly: `dispatch_research` seeds `supervisor_messages`
 * with `planToBrief(plan)`, so this harness takes a topic plus angles and renders the seed
 * through that same function rather than re-wording a brief of its own.
 *
 * Run with `npm run trace:supervisor`. Options, all optional:
 *   -- --topic "..."              override the default final_topic
 *   -- --angle "..." --angle "…"  override the default angles (repeatable)
 *   -- --judge                    spend one miniModel call mapping dispatched topics to angles
 *   -- --markers                  print the call-attribution markers and exit (no API calls)
 * Bare arguments are treated as the topic, so `-- "my topic"` works too.
 *
 * Output lands in a folder under traces/ named for the start time and the pid, which is
 * gitignored.
 */
import "dotenv/config";

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";

import {
  CallClassifier,
  RULE,
  callsTable,
  calls,
  charsOf,
  decodeChunk,
  encodeMessage,
  encodeDelta,
  makeRunDir,
  out,
  pad,
  patchModelTiers,
  requireEnv,
  tierCostTable,
  usageSourceLabel,
  usdFor,
} from "./traceCommon.js";

import { PlanType, planToBrief } from "../plan.js";
import {
  MAX_CONCURRENT_RESEARCH_UNITS,
  MAX_CONCURRENT_TAVILY_SEARCHES,
  MAX_RESEARCHER_TURNS,
  MAX_SUPERVISOR_TURNS,
} from "../config.js";
import { supervisorAssessmentPrompt } from "../prompts/supervisorAssessmentPrompt.js";
import { supervisorDispatchingPrompt } from "../prompts/supervisorDispatchingPrompt.js";
import { researcherAssessmentPrompt } from "../prompts/researcherAssessmentPrompt.js";
import { researcherDispatchingPrompt } from "../prompts/researcherDispatchingPrompt.js";
import { researcherCompressionSystemPrompt } from "../prompts/researcherCompressionPrompt.js";
import { summarizeWebpagePrompt } from "../prompts/summarizeWebpagePrompt.js";

// The plan from the 2026-09-29 run recorded in cli.log — a real negotiated plan rather than
// one invented for the harness, and the same run whose first angle traceResearcher defaults to.
const DEFAULT_PLAN: PlanType = {
  final_topic: "The tank engagement at Prokhorovka during the Battle of Kursk, 12 July 1943.",
  angles: [
    "What were the actual tank losses suffered by both the German II SS Panzer Corps and the " +
      "Soviet 5th Guards Tank Army at Prokhorovka on 12 July 1943, and how do these figures " +
      "compare to postwar claims?",
    "How did the terrain and tactical deployment at Prokhorovka influence the outcome of the " +
      "tank battle on 12 July 1943?",
    "What were the immediate operational consequences of the Prokhorovka engagement for both " +
      "the German and Soviet forces in the southern sector of the Kursk salient?",
  ],
};

// ============================================================ CALL ATTRIBUTION ============================================================

// A sentinel passed where a prompt builder interpolates a value, so the stable head of the
// template can be cut off in front of it.
const SENTINEL = "\u0000";

/**
 * The leading, caller-identifying slice of a prompt — everything before the first interpolated
 * value (`${...}` already resolved to the sentinel) or `fillTemplate` slot (`{topic}`).
 *
 * Derived from the prompt modules at runtime rather than hand-copied here, because a copied
 * prefix silently stops matching the next time someone rewords a prompt's opening line, and a
 * classifier that quietly answers "unknown" for every call is worse than no classifier.
 */
const headOf = (template: string, length = 60): string => {
  const cut = template.search(/[{\u0000]/);
  const stable = cut === -1 ? template : template.slice(0, cut);
  return stable.trim().slice(0, length);
};

const MARKERS: [string, string][] = [
  ["supervisor:assess", headOf(supervisorAssessmentPrompt)],
  [
    "supervisor:dispatch",
    headOf(supervisorDispatchingPrompt(MAX_SUPERVISOR_TURNS, MAX_CONCURRENT_RESEARCH_UNITS)),
  ],
  ["researcher:assess", headOf(researcherAssessmentPrompt)],
  [
    "researcher:dispatch",
    headOf(researcherDispatchingPrompt(MAX_RESEARCHER_TURNS, MAX_CONCURRENT_TAVILY_SEARCHES)),
  ],
  ["researcher:compress", headOf(researcherCompressionSystemPrompt)],
  ["researcher:summarise-page", headOf(summarizeWebpagePrompt(SENTINEL, SENTINEL))],
];

/**
 * Reports any marker that cannot do its job — empty, or a prefix of another — so a broken
 * classifier announces itself at startup instead of producing a plausible-looking cost split
 * in which one caller's calls have been filed under another's.
 */
const markerProblems = (): string[] => {
  const problems: string[] = [];

  for (const [owner, marker] of MARKERS) {
    if (!marker) {
      problems.push(`${owner}: marker is empty — its prompt begins with an interpolated value`);
      continue;
    }
    for (const [otherOwner, otherMarker] of MARKERS) {
      if (owner === otherOwner || !otherMarker) continue;
      if (marker.startsWith(otherMarker)) {
        problems.push(`${owner}: marker is indistinguishable from ${otherOwner}'s`);
      }
    }
  }

  return problems;
};

// Set around the harness's own optional judge call. The graph has finished by then and JS is
// single-threaded, so there is no window in which this mislabels an agent's call.
let harnessCallInFlight = false;

/**
 * Names the caller from the first message of the prompt.
 *
 * The first message, not the first *system* message: the per-page summariser in
 * `tavilySearch.ts` sends its prompt as a HumanMessage with no system message at all.
 */
const classifyCall: CallClassifier = (messages) => {
  if (harnessCallInFlight) return "harness";

  const first = messages[0] as { content?: unknown } | undefined;
  const content = first?.content;
  if (typeof content !== "string") return null;

  const text = content.trimStart();
  for (const [owner, marker] of MARKERS) {
    if (marker && text.startsWith(marker)) return owner;
  }
  return null;
};

const ownersInOrder = (): string[] => [
  ...MARKERS.map(([owner]) => owner).filter((owner) => calls.some((c) => c.owner === owner)),
  ...(calls.some((c) => c.owner === "harness") ? ["harness"] : []),
  ...(calls.some((c) => c.owner === null) ? ["unknown"] : []),
];

// ============================================================ CONSOLE DIVERSION ============================================================

/**
 * Sends the agents' own console output to supervisor.log in the run directory.
 *
 * Same technique as cli.ts: `console.log` is looked up on the global object at call time, so
 * replacing it here captures the calls already compiled into supervisorAgent/researchAgent
 * without touching either. Necessary rather than merely tidy — a traced run prints one line
 * per researcher turn from up to MAX_CONCURRENT_RESEARCH_UNITS researchers at once, which
 * buries this harness's own step lines. `console.error` is left alone: a genuine library
 * error is worth seeing on screen.
 */
const patchConsole = (logFile: string) => {
  const format = (arg: unknown) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };

  const toFile = (level: string) => (...args: unknown[]) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${args.map(format).join(" ")}\n`);
    } catch {
      // A broken log file must never take the run down with it.
    }
  };

  console.log = toFile("log");
  console.info = toFile("info");
  console.debug = toFile("debug");
  console.warn = toFile("warn");
};

// ============================================================ ENCODING ============================================================

type SupervisorSnapshot = {
  supervisor_messages?: BaseMessage[];
  notes?: string[];
  raw_notes?: string[];
  research_iterations?: number;
};

const encodeState = (state: SupervisorSnapshot) => ({
  research_iterations: state.research_iterations ?? null,
  notes_count: state.notes?.length ?? 0,
  notes_chars: (state.notes ?? []).map((n) => n.length),
  raw_notes_count: state.raw_notes?.length ?? 0,
  raw_notes_chars: (state.raw_notes ?? []).map((n) => n.length),
  supervisor_messages: (state.supervisor_messages ?? []).map(encodeMessage),
});

// ============================================================ TURN RECONSTRUCTION ============================================================

type Dispatch = { topic: string; id: string | null };

type Returned = {
  // Research results come back as plain `{role: "tool"}` objects with no name (see
  // supervisor_tool_node), so an unnamed tool message is a researcher's output and a named
  // one is a synthetic control message.
  name: string | null;
  chars: number;
  synthetic: boolean;
};

type TurnSummary = {
  n: number;
  assessmentChars: number;
  dispatched: Dispatch[];
  completeResearch: boolean;
  returned: Returned[];
};

/**
 * Rebuilds the turn structure from the final message list. The supervisor's shape is strict:
 * a seed HumanMessage carrying the brief, then per turn an assessment AIMessage (no tool
 * calls), a dispatch AIMessage (tool calls), and one ToolMessage per tool call — carrying
 * either a researcher's `compressed_research` or a synthetic "<...>" completion marker.
 */
const summariseTurns = (messages: BaseMessage[]): TurnSummary[] => {
  const turns: TurnSummary[] = [];
  let current: TurnSummary | undefined;

  for (const message of messages) {
    const type = message.getType();

    if (type === "ai") {
      const toolCalls = (message as AIMessage).tool_calls ?? [];

      if (toolCalls.length === 0) {
        current = {
          n: turns.length + 1,
          assessmentChars: charsOf(message.content),
          dispatched: [],
          completeResearch: false,
          returned: [],
        };
        turns.push(current);
        continue;
      }

      // A dispatch with no preceding assessment would mean the two-call split broke; record
      // the turn anyway rather than dropping the evidence.
      if (!current) {
        current = {
          n: turns.length + 1,
          assessmentChars: 0,
          dispatched: [],
          completeResearch: false,
          returned: [],
        };
        turns.push(current);
      }

      current.dispatched = toolCalls
        .filter((tc) => tc.name === "ConductResearch")
        .map((tc) => ({
          topic: String((tc.args as { researchTopic?: unknown }).researchTopic ?? ""),
          id: tc.id ?? null,
        }));
      current.completeResearch = toolCalls.some((tc) => tc.name === "CompleteResearch");
      continue;
    }

    if (type === "tool" && current) {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      current.returned.push({
        name: (message as { name?: string }).name ?? null,
        chars: content.length,
        // Synthetic control-flow messages are wrapped in angle brackets by convention.
        synthetic: content.startsWith("<"),
      });
    }
  }

  return turns;
};

// ============================================================ ANGLE COVERAGE ============================================================

// Enough stopwords to stop two unrelated war topics scoring 40% on "the", "of" and "were".
const STOPWORDS = new Set([
  "about", "actual", "after", "also", "and", "any", "are", "both", "but", "compare", "did",
  "does", "during", "each", "for", "from", "had", "has", "have", "how", "influence", "into",
  "its", "more", "most", "much", "not", "research", "results", "than", "that", "the", "their",
  "them", "there", "these", "they", "this", "those", "topic", "underlying", "used", "using",
  "was", "were", "what", "when", "which", "who", "why", "with", "would", "your",
]);

const contentWords = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );

/**
 * Share of an angle's content words that also appear in a dispatched topic.
 *
 * Containment rather than Jaccard because the supervisor is instructed to write a topic "at
 * least a paragraph" long: a faithful dispatch is far longer than the angle it covers, and
 * Jaccard would punish it for the extra words.
 *
 * This is a hint, not a verdict. It cannot see a paraphrase that reuses no vocabulary, and it
 * cannot tell a topic that covers an angle from one that merely mentions it. `--judge` exists
 * for when the hint is not enough.
 */
const overlap = (angle: string, topic: string): number => {
  const angleWords = contentWords(angle);
  if (!angleWords.size) return 0;

  const topicWords = contentWords(topic);
  let hits = 0;
  for (const word of angleWords) if (topicWords.has(word)) hits += 1;
  return hits / angleWords.size;
};

/**
 * Below this an angle is reported as unmatched.
 *
 * Not near zero, because the floor for *unrelated* angles of the same subject is not zero:
 * every angle of one battle shares its proper nouns. An offline run in which only two of the
 * three default angles were dispatched scored the undispatched one at 25% against a topic
 * about tank losses, purely on "prokhorovka", "1943", "german", "soviet" and "tank" — while
 * the two that were dispatched scored 87% and 100%. The gap between those is wide, so the
 * threshold sits in the middle of it rather than at the bottom.
 *
 * It is a threshold for "worth a human look", not a verdict: the angle and its best-matching
 * topic are printed in full underneath, so the reader never has to trust the number.
 */
const WEAK_OVERLAP = 0.5;

type Coverage = {
  angle: string;
  index: number;
  best: { turn: number; topic: string; score: number } | null;
};

const coverageOf = (angles: string[], turns: TurnSummary[]): Coverage[] =>
  angles.map((angle, index) => {
    let best: Coverage["best"] = null;

    for (const turn of turns) {
      for (const dispatch of turn.dispatched) {
        const score = overlap(angle, dispatch.topic);
        if (!best || score > best.score) best = { turn: turn.n, topic: dispatch.topic, score };
      }
    }

    return { angle, index, best };
  });

/**
 * One miniModel call mapping each dispatched topic to the angle it covers, or to none.
 *
 * Off by default: the point of this harness is to measure the supervisor, and an LLM judge
 * introduces a second thing that can be wrong. When it runs, its own call is tagged `harness`
 * so it never enters the supervisor-versus-researcher cost split. A malformed reply is
 * reported verbatim rather than parsed into a false verdict.
 */
const judgeCoverage = async (
  plan: PlanType,
  turns: TurnSummary[],
): Promise<{ text: string; parsed: { topic: number; angle: number | null; why: string }[] | null }> => {
  const dispatched = turns.flatMap((turn) => turn.dispatched.map((d) => d.topic));
  if (!dispatched.length) return { text: "(no ConductResearch calls to judge)", parsed: null };

  const { miniModel } = await import("../model.js");

  const prompt =
    `A research supervisor was given this topic and these approved angles, and dispatched the ` +
    `research topics below to sub-agents. For each dispatched topic, say which single angle it ` +
    `covers, or null if it covers none of them.\n\n` +
    `TOPIC: ${plan.final_topic}\n\n` +
    `ANGLES:\n${plan.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n` +
    `DISPATCHED TOPICS:\n${dispatched.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}\n\n` +
    `Reply with JSON only, no prose and no code fence: ` +
    `{"mapping":[{"topic":1,"angle":2,"why":"one short sentence"}]}. ` +
    `Use null for angle when a dispatched topic covers no approved angle.`;

  harnessCallInFlight = true;
  try {
    const response = await miniModel.invoke([new HumanMessage(prompt)]);
    const text = response.content as string;

    try {
      const parsed = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, "").trim());
      return { text, parsed: parsed.mapping ?? null };
    } catch {
      return { text, parsed: null };
    }
  } catch (err) {
    return { text: `(judge call failed: ${err instanceof Error ? err.message : String(err)})`, parsed: null };
  } finally {
    harnessCallInFlight = false;
  }
};

// ============================================================ REPORTS ============================================================

const buildTranscript = (state: SupervisorSnapshot, plan: PlanType): string => {
  const parts: string[] = [
    "# Supervisor transcript",
    "",
    `**Topic:** ${plan.final_topic}`,
    `**Angles:** ${plan.angles.length}`,
    `**Messages:** ${state.supervisor_messages?.length ?? 0}`,
    `**Final research_iterations:** ${state.research_iterations ?? "(none)"}`,
    "",
    "Every message in `supervisor_messages`, in order, verbatim. The tool messages are the",
    "`compressed_research` each spawned researcher returned — all the supervisor ever sees of",
    "a researcher's work.",
    "",
  ];

  (state.supervisor_messages ?? []).forEach((message, i) => {
    const m = encodeMessage(message);
    const label = [m.type, m.name].filter(Boolean).join(" — ");

    parts.push(RULE, `## [${i}] ${label}`, "");
    if (m.tool_call_id) parts.push(`tool_call_id: \`${m.tool_call_id}\``);
    if (m.tool_calls.length) {
      parts.push("tool_calls:");
      for (const tc of m.tool_calls) {
        parts.push(`  - ${tc.name}(${JSON.stringify(tc.args)})  id=${tc.id ?? "?"}`);
      }
    }
    parts.push(`chars: ${m.chars}`, "", m.content, "");
  });

  parts.push(RULE, "## notes", "", `count: ${state.notes?.length ?? 0}`, "");
  (state.notes ?? []).forEach((note, i) => {
    parts.push(`### notes[${i}] — ${note.length} chars`, "", note, "");
  });

  parts.push(RULE, "## raw_notes", "", `count: ${state.raw_notes?.length ?? 0}`, "");
  (state.raw_notes ?? []).forEach((note, i) => {
    parts.push(`### raw_notes[${i}] — ${note.length} chars`, "", note, "");
  });

  return parts.join("\n");
};

type StepTiming = { step: number; node: string; ms: number };

const buildSummary = (
  state: SupervisorSnapshot,
  turns: TurnSummary[],
  plan: PlanType,
  timings: StepTiming[],
  judged: { text: string; parsed: { topic: number; angle: number | null; why: string }[] | null } | null,
  meta: { durationMs: number; shape: string; error: string | null; markerProblems: string[] },
): string => {
  const msFor = (node: string) => timings.filter((t) => t.node === node).map((t) => t.ms);
  const toolNodeMs = msFor("supervisor_tool_node");
  const supervisorNodeMs = msFor("supervisor_node");

  const dispatchedTotal = turns.reduce((sum, t) => sum + t.dispatched.length, 0);
  const researcherCalls = calls.filter((c) => c.owner?.startsWith("researcher:"));
  const supervisorCalls = calls.filter((c) => c.owner?.startsWith("supervisor:"));

  const parts: (string | null)[] = [
    "# Supervisor run summary",
    "",
    `**Topic:** ${plan.final_topic}`,
    `**Angles approved:** ${plan.angles.length}`,
    `**Wall time:** ${(meta.durationMs / 1000).toFixed(1)}s`,
    `**Stream chunk shape:** ${meta.shape}`,
    `**Token usage read from:** ${usageSourceLabel()}`,
    `**Final research_iterations:** ${state.research_iterations ?? "(none)"} (MAX_SUPERVISOR_TURNS = ${MAX_SUPERVISOR_TURNS})`,
    `**Messages in final state:** ${state.supervisor_messages?.length ?? 0}`,
    `**Researchers spawned:** ${dispatchedTotal}`,
    `**notes:** ${state.notes?.length ?? 0} entries, ${(state.notes ?? []).reduce((s, n) => s + n.length, 0)} chars`,
    `**raw_notes:** ${state.raw_notes?.length ?? 0} entries, ${(state.raw_notes ?? []).reduce((s, n) => s + n.length, 0)} chars`,
    `**LLM calls:** ${calls.length} (${supervisorCalls.length} supervisor, ${researcherCalls.length} researcher, ` +
      `${calls.filter((c) => c.owner === "harness").length} harness, ${calls.filter((c) => c.owner === null).length} unattributed)`,
    meta.error ? `**Run ended with an error:** ${meta.error}` : null,
    meta.markerProblems.length
      ? `**Call attribution is unreliable in this run:** ${meta.markerProblems.join("; ")}`
      : null,
    "",
    "## Per-turn behaviour",
    "",
    "`Returned chars` is the total `compressed_research` the turn's researchers handed back —",
    "everything the supervisor learns from a turn, and what its next assessment is charged for.",
    "",
    "| Turn | Assessment chars | ConductResearch | CompleteResearch | Tool msgs | Returned chars | Assess+dispatch s | Researchers s |",
    "|---|---|---|---|---|---|---|---|",
  ];

  turns.forEach((turn, i) => {
    const returnedChars = turn.returned.filter((r) => !r.synthetic).reduce((s, r) => s + r.chars, 0);
    const assessS = supervisorNodeMs[i] === undefined ? "" : (supervisorNodeMs[i] / 1000).toFixed(1);
    const toolS = toolNodeMs[i] === undefined ? "" : (toolNodeMs[i] / 1000).toFixed(1);
    parts.push(
      `| ${turn.n} | ${turn.assessmentChars} | ${turn.dispatched.length} | ${turn.completeResearch ? "yes" : "no"} ` +
        `| ${turn.returned.length} | ${returnedChars} | ${assessS} | ${toolS} |`,
    );
  });

  parts.push("", "### Topics dispatched, verbatim", "");
  for (const turn of turns) {
    if (!turn.dispatched.length) {
      parts.push(`- **Turn ${turn.n}:** none${turn.completeResearch ? " (CompleteResearch)" : ""}`);
      continue;
    }
    parts.push(`- **Turn ${turn.n}:**`);
    turn.dispatched.forEach((dispatch, i) => {
      const returned = turn.returned.filter((r) => !r.synthetic)[i];
      parts.push(
        `  ${i + 1}. ${dispatch.topic}`,
        `     _returned ${returned ? `${returned.chars} chars` : "nothing"}_`,
      );
    });
  }

  // The open question this harness was built to answer: dispatch_research hands over the
  // confirmed plan as prose, but the supervisor derives its own sub-topics from it, so the
  // angles the user approved are a suggestion rather than a guarantee (see the TODO in
  // src/plan.ts). The angles and the topics are printed side by side because reading them is
  // the real check; the overlap figure only says where to look first.
  parts.push(
    "",
    "## Angle coverage",
    "",
    "Did the supervisor research the angles the user approved? `Overlap` is the share of the",
    "angle's content words that appear in its best-matching dispatched topic — a hint for where",
    "to look, not a verdict. Read the pair below it before concluding anything.",
    "",
    "| Angle | Best-matching dispatch | Overlap |",
    "|---|---|---|",
  );

  const coverage = coverageOf(plan.angles, turns);
  for (const { index, best } of coverage) {
    const where = best ? `turn ${best.turn}` : "— nothing dispatched";
    const score = best ? `${(best.score * 100).toFixed(0)}%` : "—";
    parts.push(`| ${index + 1} | ${where} | ${score}${best && best.score < WEAK_OVERLAP ? " ⚠" : ""} |`);
  }

  parts.push("", "### Each angle against its best match", "");
  for (const { angle, index, best } of coverage) {
    parts.push(`**Angle ${index + 1}.** ${angle}`, "");
    if (!best) {
      parts.push("> No ConductResearch call was made at all.", "");
      continue;
    }
    parts.push(
      `> **Best match (turn ${best.turn}, overlap ${(best.score * 100).toFixed(0)}%):** ${best.topic}`,
      "",
    );
  }

  const weak = coverage.filter((c) => !c.best || c.best.score < WEAK_OVERLAP);
  parts.push(
    weak.length
      ? `**${weak.length} of ${plan.angles.length} angles ${weak.length === 1 ? "has" : "have"} no closely-matching dispatch** ` +
          `(angle${weak.length > 1 ? "s" : ""} ${weak.map((c) => c.index + 1).join(", ")}). ` +
          `Either the supervisor substituted its own sub-topics, or it paraphrased without reusing vocabulary — read the pairs above.`
      : `**Every angle has a closely-matching dispatched topic.**`,
    "",
  );

  if (judged) {
    parts.push("### LLM judge mapping (`--judge`)", "");
    if (judged.parsed) {
      const dispatched = turns.flatMap((t) => t.dispatched.map((d) => d.topic));
      parts.push("| Dispatched topic | Angle | Why |", "|---|---|---|");
      for (const row of judged.parsed) {
        const topic = dispatched[row.topic - 1] ?? `(topic ${row.topic} not found)`;
        parts.push(
          `| ${topic.slice(0, 90)}${topic.length > 90 ? "…" : ""} | ${row.angle ?? "none"} | ${row.why ?? ""} |`,
        );
      }
    } else {
      parts.push("The judge's reply could not be parsed as JSON. Verbatim:", "", "```", judged.text, "```");
    }
    parts.push("");
  }

  // Where the money went. This is the split the flat per-call table cannot show: the
  // supervisor's own spend is two calls per turn, while everything else in the process belongs
  // to the researchers it spawned.
  parts.push("## Cost by caller", "", "| Owner | Calls | Input tokens | Output tokens | Approx USD |", "|---|---|---|---|---|");

  let grand = 0;
  for (const owner of ownersInOrder()) {
    const ownerCalls = calls.filter((c) => (owner === "unknown" ? c.owner === null : c.owner === owner));
    const usd = usdFor(ownerCalls);
    grand += usd;
    parts.push(
      `| ${owner} | ${ownerCalls.length} | ${ownerCalls.reduce((s, c) => s + (c.inputTokens ?? 0), 0)} ` +
        `| ${ownerCalls.reduce((s, c) => s + (c.outputTokens ?? 0), 0)} | $${usd.toFixed(4)} |`,
    );
  }
  parts.push(`| **total** | ${calls.length} | | | **$${grand.toFixed(4)}** |`);

  const supervisorUsd = usdFor(supervisorCalls);
  const researcherUsd = usdFor(researcherCalls);
  parts.push(
    "",
    `Supervisor **$${supervisorUsd.toFixed(4)}** versus researchers **$${researcherUsd.toFixed(4)}**` +
      (researcherUsd > 0 ? ` — ${(researcherUsd / Math.max(supervisorUsd, 1e-9)).toFixed(1)}× the orchestration cost.` : "."),
    "",
    ...callsTable(calls, true),
    ...tierCostTable(),
    "",
    "## Supersteps, in order",
    "",
    "| Step | Node | s |",
    "|---|---|---|",
    ...timings.map((t) => `| ${t.step} | ${t.node} | ${(t.ms / 1000).toFixed(1)} |`),
  );

  return parts.filter((line): line is string => line !== null).join("\n") + "\n";
};

// ============================================================ MAIN ============================================================

const parseArgs = (argv: string[]): { plan: PlanType; judge: boolean; markersOnly: boolean } => {
  const angles: string[] = [];
  const bare: string[] = [];
  let topic = "";
  let judge = false;
  let markersOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--topic") {
      topic = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--angle") {
      const angle = argv[i + 1];
      if (angle) angles.push(angle);
      i += 1;
    } else if (arg === "--judge") {
      judge = true;
    } else if (arg === "--markers") {
      markersOnly = true;
    } else if (!arg.startsWith("-")) {
      bare.push(arg);
    }
  }

  const finalTopic = (topic || bare.join(" ")).trim();

  // Angles without a topic, or a topic without angles, would silently trace half a plan — and
  // the angle-coverage section is the point of this harness. Fall back to the whole default
  // plan rather than mixing one of its halves with an override of the other.
  if (!finalTopic && !angles.length) return { plan: DEFAULT_PLAN, judge, markersOnly };
  if (finalTopic && !angles.length) return { plan: { final_topic: finalTopic, angles: [finalTopic] }, judge, markersOnly };
  if (!finalTopic && angles.length) return { plan: { final_topic: angles[0], angles }, judge, markersOnly };
  return { plan: { final_topic: finalTopic, angles }, judge, markersOnly };
};

async function main() {
  const { plan, judge, markersOnly } = parseArgs(process.argv.slice(2));
  const problems = markerProblems();

  if (markersOnly) {
    out();
    out("Call-attribution markers (derived from the prompt modules):");
    for (const [owner, marker] of MARKERS) out(`  ${owner.padEnd(28)} ${JSON.stringify(marker)}`);
    out();
    out(problems.length ? `Problems: ${problems.join("; ")}` : "No problems: all markers are non-empty and distinct.");
    out();
    return;
  }

  requireEnv();

  // Both imports are dynamic and ordered, for the same reason as in traceResearcher: model.ts
  // builds its ChatOpenAI instances at module scope and throws on a missing key, so the check
  // above has to run first. Patching before supervisorAgent loads is also what catches its
  // module-scope `nanoModel.bindTools(...)` — and, transitively, researchAgent's, since
  // supervisorAgent imports it.
  const models = await import("../model.js");
  patchModelTiers(models, classifyCall);

  const { supervisorAgent } = await import("../supervisorAgent.js");

  const runDir = makeRunDir("supervisor");
  const updatesPath = join(runDir, "updates.jsonl");

  // Seeded exactly as dispatch_research seeds it — same planToBrief, so the supervisor reads
  // the brief this harness renders in the same form production hands it.
  const brief = planToBrief(plan);
  const seed = {
    supervisor_messages: [new HumanMessage(brief)],
    research_iterations: 0,
  };

  out();
  out(`Tracing supervisorAgent → ${runDir}`);
  out(`Topic: ${plan.final_topic}`);
  plan.angles.forEach((angle, i) => out(`  angle ${i + 1}: ${angle}`));
  out(
    `Up to ${MAX_SUPERVISOR_TURNS + 1} turns × ${MAX_CONCURRENT_RESEARCH_UNITS} researchers — this makes real paid calls.`,
  );
  if (problems.length) out(`WARNING: call attribution may be unreliable — ${problems.join("; ")}`);
  out(RULE);

  writeFileSync(join(runDir, "brief.md"), `${brief}\n`, "utf8");
  patchConsole(join(runDir, "supervisor.log"));

  const startedAt = Date.now();
  let step = 0;
  let lastNode = "start";
  let lastStepAt = startedAt;
  let shape = "(no chunks received)";
  const timings: StepTiming[] = [];
  let finalState: SupervisorSnapshot = {};
  let error: string | null = null;

  try {
    const stream = await supervisorAgent.stream(seed as never, {
      streamMode: ["updates", "values"],
      recursionLimit: 100,
    });

    for await (const chunk of stream) {
      const { mode, payload } = decodeChunk(chunk);
      if (shape === "(no chunks received)") {
        shape = mode === "unknown" ? `single payload, not a [mode, payload] tuple` : `[mode, payload] tuple`;
      }

      if (mode === "updates" && payload && typeof payload === "object") {
        for (const [node, delta] of Object.entries(payload as Record<string, unknown>)) {
          lastNode = node;
          step += 1;
          // Wall time of the superstep that just finished. For supervisor_tool_node this is
          // how long the parallel researchers took, which is most of a run.
          const ms = Date.now() - lastStepAt;
          lastStepAt = Date.now();
          timings.push({ step, node, ms });

          appendFileSync(
            updatesPath,
            `${JSON.stringify({ step, node, ms, delta: encodeDelta(delta, "supervisor_messages") })}\n`,
          );
          out(`  step ${pad(step, 2)}  ${node}  ${(ms / 1000).toFixed(1)}s`);
        }
        continue;
      }

      // "values" carries no node name, so it is labelled with the node whose update just
      // arrived. Both modes fire per superstep, so the pairing holds — and the step number in
      // the filename makes any mismatch visible against updates.jsonl rather than hidden.
      if (mode === "values" && payload && typeof payload === "object") {
        finalState = payload as SupervisorSnapshot;
        writeFileSync(
          join(runDir, `state-${pad(step, 2)}-${lastNode}.json`),
          `${JSON.stringify(encodeState(finalState), null, 2)}\n`,
        );
        continue;
      }

      appendFileSync(updatesPath, `${JSON.stringify({ step, node: `raw:${mode}`, delta: null })}\n`);
    }
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    out(RULE);
    out(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    out("Writing the partial trace anyway.");
  }

  const turns = summariseTurns(finalState.supervisor_messages ?? []);
  const judged = judge ? await judgeCoverage(plan, turns) : null;
  const durationMs = Date.now() - startedAt;

  writeFileSync(join(runDir, "transcript.md"), buildTranscript(finalState, plan), "utf8");
  writeFileSync(
    join(runDir, "summary.md"),
    buildSummary(finalState, turns, plan, timings, judged, { durationMs, shape, error, markerProblems: problems }),
    "utf8",
  );
  writeFileSync(join(runDir, "calls.json"), `${JSON.stringify(calls, null, 2)}\n`, "utf8");

  const spawned = turns.reduce((sum, t) => sum + t.dispatched.length, 0);
  out(RULE);
  out(
    `Done in ${(durationMs / 1000).toFixed(1)}s — ${turns.length} turns, ${spawned} researchers spawned, ` +
      `${calls.length} LLM calls, ~$${usdFor(calls).toFixed(4)}.`,
  );
  out(`  ${join(runDir, "summary.md")}`);
  out(`  ${join(runDir, "transcript.md")}`);
  out();

  if (error) process.exitCode = 1;
}

main().catch((err) => {
  out(`Harness failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
