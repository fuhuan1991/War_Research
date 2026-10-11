/**
 * A tracing harness for `researchAgent`, built for analysis. It is not part of the pipeline
 * and nothing in `src/` imports it.
 *
 * The point is to see how information enters `ResearcherState` at runtime without changing
 * the agent to find out — an instrumented agent is not the agent you want to analyse. Two
 * things make that possible:
 *
 *   1. `streamMode: ["updates", "values"]` already exposes the whole state machine: "updates"
 *      is the delta each node returned, "values" is the full ResearcherState after it.
 *   2. The model tiers are module-scope singletons and the agents look `invoke` up on them at
 *      call time, so wrapping it here records every LLM call's token usage without touching
 *      an agent file. Same technique cli.ts uses to divert console.log.
 *
 * (2) is the only way to see the per-page `miniModel` summarisation calls inside
 * executeTavilySearch: those never enter `researcher_messages`, so the stream cannot see them.
 *
 * Both mechanisms live in `traceCommon.ts`, which `traceSupervisor.ts` shares. What stays
 * here is everything written against the researcher's own state shape and turn structure.
 *
 * Run with `npm run trace:researcher` (append `-- "your topic"` to override the default).
 * Output lands in a folder under traces/ named for the start time and the pid, which is
 * gitignored.
 */
import "dotenv/config";

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";

import {
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
} from "./traceCommon.js";

// One of the angles from the 2026-09-29 run in cli.log, so the trace reflects a topic the
// pipeline actually produced rather than one invented for the harness.
const DEFAULT_TOPIC =
  "What were the actual tank losses suffered by both the German II SS Panzer Corps and the " +
  "Soviet 5th Guards Tank Army at Prokhorovka on 12 July 1943, and how do these figures " +
  "compare to postwar claims?";

// ============================================================ ENCODING ============================================================

type ResearcherSnapshot = {
  research_topic?: string;
  researcher_messages?: BaseMessage[];
  compressed_research?: string;
  raw_notes?: string[];
  seen_urls?: string[];
  research_iterations?: number;
};

const encodeState = (state: ResearcherSnapshot) => ({
  research_topic: state.research_topic ?? null,
  research_iterations: state.research_iterations ?? null,
  compressed_research_chars: charsOf(state.compressed_research ?? ""),
  raw_notes_count: state.raw_notes?.length ?? 0,
  raw_notes_chars: (state.raw_notes ?? []).map((n) => n.length),
  seen_urls_count: state.seen_urls?.length ?? 0,
  seen_urls: state.seen_urls ?? [],
  researcher_messages: (state.researcher_messages ?? []).map(encodeMessage),
});

// ============================================================ REPORTS ============================================================

const buildTranscript = (state: ResearcherSnapshot): string => {
  const parts: string[] = [
    "# Researcher transcript",
    "",
    `**Topic:** ${state.research_topic ?? "(none)"}`,
    `**Messages:** ${state.researcher_messages?.length ?? 0}`,
    `**Final research_iterations:** ${state.research_iterations ?? "(none)"}`,
    "",
    "Every message in `researcher_messages`, in order, verbatim.",
    "",
  ];

  (state.researcher_messages ?? []).forEach((message, i) => {
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

  parts.push(
    RULE,
    "## compressed_research",
    "",
    `chars: ${charsOf(state.compressed_research ?? "")}`,
    "",
    state.compressed_research || "(empty)",
    "",
    RULE,
    "## raw_notes",
    "",
    `count: ${state.raw_notes?.length ?? 0}`,
    "",
  );
  (state.raw_notes ?? []).forEach((note, i) => {
    parts.push(`### raw_notes[${i}] — ${note.length} chars`, "", note, "");
  });

  return parts.join("\n");
};

type TurnSummary = {
  n: number;
  assessmentChars: number;
  queries: string[];
  completeSearch: boolean;
  results: { name: string; chars: number; sources: number; omitted: number; skipped: boolean }[];
};

/**
 * Rebuilds the turn structure from the final message list. The researcher's shape is strict:
 * a seed HumanMessage, then per turn an assessment AIMessage (no tool calls), a dispatch
 * AIMessage (tool calls), and the ToolMessages answering them.
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
          queries: [],
          completeSearch: false,
          results: [],
        };
        turns.push(current);
        continue;
      }

      // A dispatch with no preceding assessment would mean the two-call split broke; record
      // the turn anyway rather than dropping the evidence.
      if (!current) {
        current = { n: turns.length + 1, assessmentChars: 0, queries: [], completeSearch: false, results: [] };
        turns.push(current);
      }
      current.queries = toolCalls
        .filter((tc) => tc.name === "TavilySearch")
        .map((tc) => String((tc.args as { query?: unknown }).query ?? ""));
      current.completeSearch = toolCalls.some((tc) => tc.name === "CompleteSearch");
      continue;
    }

    if (type === "tool" && current) {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      current.results.push({
        name: (message as { name?: string }).name ?? "?",
        chars: content.length,
        sources: (content.match(/--- SOURCE /g) ?? []).length,
        // Pages the run-level dedupe withheld because an earlier search already returned them.
        // With dedupe working this should be non-zero exactly where queries overlap, and the
        // SOURCE count should never double-count a page across turns.
        omitted: Number((content.match(/ALREADY RETRIEVED — (\d+) result/) ?? [])[1] ?? 0),
        skipped: content.startsWith("<Search skipped"),
      });
    }
  }

  return turns;
};

const buildSummary = (
  state: ResearcherSnapshot,
  turns: TurnSummary[],
  meta: { topic: string; durationMs: number; shape: string; error: string | null },
): string => {
  // `string | null`, with null meaning "omit this line". The conditional error line below used
  // to be `""` and the join filtered empty strings out — which also deleted every deliberate
  // blank line, and a GFM table that directly follows a prose line is read as a continuation
  // of that paragraph rather than a table. The per-call table rendered as plain text.
  const parts: (string | null)[] = [
    "# Researcher run summary",
    "",
    `**Topic:** ${meta.topic}`,
    `**Wall time:** ${(meta.durationMs / 1000).toFixed(1)}s`,
    `**Stream chunk shape:** ${meta.shape}`,
    `**Token usage read from:** ${usageSourceLabel()}`,
    `**Final research_iterations:** ${state.research_iterations ?? "(none)"}`,
    `**Messages in final state:** ${state.researcher_messages?.length ?? 0}`,
    `**compressed_research:** ${charsOf(state.compressed_research ?? "")} chars`,
    `**raw_notes:** ${state.raw_notes?.length ?? 0} entries, ${(state.raw_notes ?? []).reduce((s, n) => s + n.length, 0)} chars`,
    // The acceptance check for run-level URL dedupe: every SOURCE block emitted should be a
    // page summarised for the first time, so these two numbers should agree. SOURCE blocks
    // exceeding unique pages means a page was summarised twice — except where a summarisation
    // failed, which releases its URL so a later search may legitimately retry it.
    `**Unique pages summarised (seen_urls):** ${state.seen_urls?.length ?? 0}`,
    `**SOURCE blocks emitted:** ${turns.reduce((s, t) => s + t.results.reduce((a, r) => a + r.sources, 0), 0)}`,
    `**Withheld as already retrieved:** ${turns.reduce((s, t) => s + t.results.reduce((a, r) => a + r.omitted, 0), 0)}`,
    meta.error ? `**Run ended with an error:** ${meta.error}` : null,
    "",
    "## Per-turn behaviour",
    "",
    "| Turn | Assessment chars | Queries | CompleteSearch | Tool msgs | Sources | Omitted | Result chars |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const turn of turns) {
    const sources = turn.results.reduce((s, r) => s + r.sources, 0);
    const omitted = turn.results.reduce((s, r) => s + r.omitted, 0);
    const chars = turn.results.reduce((s, r) => s + r.chars, 0);
    const skipped = turn.results.filter((r) => r.skipped).length;
    parts.push(
      `| ${turn.n} | ${turn.assessmentChars} | ${turn.queries.length}${skipped ? ` (+${skipped} skipped)` : ""} ` +
        `| ${turn.completeSearch ? "yes" : "no"} | ${turn.results.length} | ${sources} | ${omitted} | ${chars} |`,
    );
  }

  parts.push("", "### Queries issued", "");
  for (const turn of turns) {
    if (!turn.queries.length) {
      parts.push(`- **Turn ${turn.n}:** none${turn.completeSearch ? " (CompleteSearch)" : ""}`);
      continue;
    }
    parts.push(`- **Turn ${turn.n}:**`);
    for (const query of turn.queries) parts.push(`  - \`${query}\``);
  }

  parts.push("", ...callsTable(), ...tierCostTable());

  return parts.filter((line): line is string => line !== null).join("\n") + "\n";
};

// ============================================================ MAIN ============================================================

async function main() {
  const topic = process.argv.slice(2).filter((arg) => !arg.startsWith("-")).join(" ").trim() || DEFAULT_TOPIC;

  requireEnv();

  // Both imports are dynamic and ordered: model.ts builds its ChatOpenAI instances at module
  // scope and throws on a missing key, so the check above has to run first. Patching the tiers
  // before researchAgent loads also covers nanoModel.bindTools(), which runs at that module's
  // scope — the binding keeps a reference to the object, so it still resolves the wrapper.
  const models = await import("../model.js");
  patchModelTiers(models);

  const { researchAgent } = await import("../researchAgent.js");

  const runDir = makeRunDir("researcher");
  const updatesPath = join(runDir, "updates.jsonl");

  // Seeded exactly as supervisor_tool_node seeds it, so the trace reflects production.
  const seed = {
    research_topic: topic,
    researcher_messages: [new HumanMessage(topic)],
    research_iterations: 0,
  };

  out();
  out(`Tracing researchAgent → ${runDir}`);
  out(`Topic: ${topic}`);
  out(RULE);

  const startedAt = Date.now();
  let step = 0;
  let lastNode = "start";
  let shape = "(no chunks received)";
  let finalState: ResearcherSnapshot = {};
  let error: string | null = null;

  try {
    const stream = await researchAgent.stream(seed as never, {
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
          appendFileSync(
            updatesPath,
            `${JSON.stringify({ step, node, delta: encodeDelta(delta, "researcher_messages") })}\n`,
          );
          out(`  step ${pad(step, 2)}  ${node}`);
        }
        continue;
      }

      // "values" carries no node name, so it is labelled with the node whose update just
      // arrived. Both modes fire per superstep, so the pairing holds — and the step number in
      // the filename makes any mismatch visible against updates.jsonl rather than hidden.
      if (mode === "values" && payload && typeof payload === "object") {
        finalState = payload as ResearcherSnapshot;
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

  const durationMs = Date.now() - startedAt;
  const turns = summariseTurns(finalState.researcher_messages ?? []);

  writeFileSync(join(runDir, "transcript.md"), buildTranscript(finalState), "utf8");
  writeFileSync(join(runDir, "summary.md"), buildSummary(finalState, turns, { topic, durationMs, shape, error }), "utf8");
  writeFileSync(join(runDir, "calls.json"), `${JSON.stringify(calls, null, 2)}\n`, "utf8");

  out(RULE);
  out(`Done in ${(durationMs / 1000).toFixed(1)}s — ${calls.length} LLM calls, ${turns.length} turns.`);
  out(`  ${join(runDir, "summary.md")}`);
  out(`  ${join(runDir, "transcript.md")}`);
  out();

  if (error) process.exitCode = 1;
}

main().catch((err) => {
  out(`Harness failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
