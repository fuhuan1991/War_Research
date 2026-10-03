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
 * Run with `npm run trace:researcher` (append `-- "your topic"` to override the default).
 * Output lands in a timestamped folder under traces/, which is gitignored.
 */
import "dotenv/config";

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const TRACE_ROOT = join(process.cwd(), "traces");
const REQUIRED_KEYS = ["OPENAI_API_KEY", "TAVILY_API_KEY"];

// One of the angles from the 2026-09-29 run in cli.log, so the trace reflects a topic the
// pipeline actually produced rather than one invented for the harness.
const DEFAULT_TOPIC =
  "What were the actual tank losses suffered by both the German II SS Panzer Corps and the " +
  "Soviet 5th Guards Tank Army at Prokhorovka on 12 July 1943, and how do these figures " +
  "compare to postwar claims?";

// Approximate published USD prices per 1M tokens, for an order-of-magnitude total only.
// Re-check before quoting these anywhere that matters.
const PRICES: Record<Tier, { in: number; out: number }> = {
  full: { in: 2.0, out: 8.0 }, // gpt-4.1
  mini: { in: 0.4, out: 1.6 }, // gpt-4.1-mini
  nano: { in: 0.1, out: 0.4 }, // gpt-4.1-nano
};

const out = (text = "") => process.stdout.write(`${text}\n`);
const RULE = "─".repeat(78);

// ============================================================ LLM CALL RECORDING ============================================================

type Tier = "full" | "mini" | "nano";

type CallRecord = {
  seq: number;
  tier: Tier;
  startedAt: number;
  durationMs: number;
  promptMessages: number;
  promptChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: string | null;
};

const calls: CallRecord[] = [];

const charsOf = (content: unknown): number => {
  if (typeof content === "string") return content.length;
  if (content === null || content === undefined) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return String(content).length;
  }
};

/**
 * Token usage moved between fields across langchain versions, so try both rather than
 * assuming. Which one answered is recorded, so the summary can say where the numbers
 * came from instead of presenting them as unattributed.
 */
const readUsage = (result: unknown): { in: number | null; out: number | null; source: string | null } => {
  const message = result as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
    response_metadata?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } };
  };

  const modern = message?.usage_metadata;
  if (modern && typeof modern.input_tokens === "number") {
    return { in: modern.input_tokens, out: modern.output_tokens ?? null, source: "usage_metadata" };
  }

  const legacy = message?.response_metadata?.tokenUsage;
  if (legacy && typeof legacy.promptTokens === "number") {
    return { in: legacy.promptTokens, out: legacy.completionTokens ?? null, source: "response_metadata.tokenUsage" };
  }

  return { in: null, out: null, source: null };
};

type Patchable = { invoke: (...args: unknown[]) => Promise<unknown> };
type BindsTools = { bindTools: (...args: unknown[]) => unknown };

/**
 * Wraps `invoke` on one model singleton. `promptChars` is recorded alongside the token
 * count because it needs no provider cooperation — if usage metadata ever comes back empty
 * the growth curve is still measurable.
 */
const patchModel = (model: Patchable, tier: Tier) => {
  const original = model.invoke.bind(model);

  model.invoke = async (...args: unknown[]) => {
    const input = args[0];
    const messages: unknown[] = Array.isArray(input) ? input : [input];
    const startedAt = Date.now();

    const result = await original(...args);

    const usage = readUsage(result);
    calls.push({
      seq: calls.length + 1,
      tier,
      startedAt,
      durationMs: Date.now() - startedAt,
      promptMessages: messages.length,
      promptChars: messages.reduce<number>(
        (sum, m) => sum + charsOf((m as { content?: unknown })?.content ?? m),
        0,
      ),
      inputTokens: usage.in,
      outputTokens: usage.out,
      usageSource: usage.source,
    });

    return result;
  };
};

/**
 * Patches the model a `bindTools()` call hands back.
 *
 * Necessary because `ChatOpenAI.bindTools()` does not return a RunnableBinding delegating to
 * the original — it returns a *fresh ChatOpenAI clone*, verified against this version. So
 * researchAgent's module-scope `nanoModel.bindTools([...])` produces an object the singleton
 * patch above can never observe, and the dispatch call is invisible without this. The clone
 * does not route through `nanoModel.invoke`, so there is no double counting.
 */
const patchBindTools = (model: BindsTools, tier: Tier) => {
  const original = model.bindTools.bind(model);

  model.bindTools = (...args: unknown[]) => {
    const bound = original(...args);
    patchModel(bound as Patchable, tier);
    return bound;
  };
};

// ============================================================ ENCODING ============================================================

type EncodedMessage = {
  type: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls: { name: string; id?: string; args: unknown }[];
  chars: number;
  content: string;
};

// BaseMessage.toJSON() exists but emits a deep serialisation envelope that buries the fields
// this analysis is about, so encode the interesting parts by hand instead.
const encodeMessage = (message: BaseMessage): EncodedMessage => ({
  type: message.getType(),
  name: (message as { name?: string }).name ?? null,
  tool_call_id: (message as ToolMessage).tool_call_id ?? null,
  tool_calls: ((message as AIMessage).tool_calls ?? []).map((tc) => ({
    name: tc.name,
    id: tc.id,
    args: tc.args,
  })),
  chars: charsOf(message.content),
  content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
});

type ResearcherSnapshot = {
  research_topic?: string;
  researcher_messages?: BaseMessage[];
  compressed_research?: string;
  raw_notes?: string[];
  research_iterations?: number;
};

const encodeState = (state: ResearcherSnapshot) => ({
  research_topic: state.research_topic ?? null,
  research_iterations: state.research_iterations ?? null,
  compressed_research_chars: charsOf(state.compressed_research ?? ""),
  raw_notes_count: state.raw_notes?.length ?? 0,
  raw_notes_chars: (state.raw_notes ?? []).map((n) => n.length),
  researcher_messages: (state.researcher_messages ?? []).map(encodeMessage),
});

const encodeDelta = (delta: unknown) => {
  if (!delta || typeof delta !== "object") return delta ?? null;

  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
    encoded[key] =
      key === "researcher_messages" && Array.isArray(value)
        ? value.map((m) => encodeMessage(m as BaseMessage))
        : value;
  }
  return encoded;
};

// With a multi-mode streamMode LangGraph yields [mode, payload] tuples. The shape is
// verified against the first chunk at runtime rather than assumed, and reported in the
// summary, so a version change shows up as a note instead of a silently empty trace.
const decodeChunk = (chunk: unknown): { mode: string; payload: unknown } => {
  if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
    return { mode: chunk[0], payload: chunk[1] };
  }
  return { mode: "unknown", payload: chunk };
};

// ============================================================ REPORTS ============================================================

const pad = (n: number, width: number) => String(n).padStart(width, "0");

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
  results: { name: string; chars: number; sources: number; skipped: boolean }[];
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
  const usageSources = [...new Set(calls.map((c) => c.usageSource).filter(Boolean))];
  const total = (tier: Tier, field: "inputTokens" | "outputTokens") =>
    calls.filter((c) => c.tier === tier).reduce((sum, c) => sum + (c[field] ?? 0), 0);

  const parts: string[] = [
    "# Researcher run summary",
    "",
    `**Topic:** ${meta.topic}`,
    `**Wall time:** ${(meta.durationMs / 1000).toFixed(1)}s`,
    `**Stream chunk shape:** ${meta.shape}`,
    `**Token usage read from:** ${usageSources.length ? usageSources.join(", ") : "nothing populated — token columns are blank"}`,
    `**Final research_iterations:** ${state.research_iterations ?? "(none)"}`,
    `**Messages in final state:** ${state.researcher_messages?.length ?? 0}`,
    `**compressed_research:** ${charsOf(state.compressed_research ?? "")} chars`,
    `**raw_notes:** ${state.raw_notes?.length ?? 0} entries, ${(state.raw_notes ?? []).reduce((s, n) => s + n.length, 0)} chars`,
    meta.error ? `**Run ended with an error:** ${meta.error}` : "",
    "",
    "## Per-turn behaviour",
    "",
    "| Turn | Assessment chars | Queries | CompleteSearch | Tool msgs | Sources | Result chars |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const turn of turns) {
    const sources = turn.results.reduce((s, r) => s + r.sources, 0);
    const chars = turn.results.reduce((s, r) => s + r.chars, 0);
    const skipped = turn.results.filter((r) => r.skipped).length;
    parts.push(
      `| ${turn.n} | ${turn.assessmentChars} | ${turn.queries.length}${skipped ? ` (+${skipped} skipped)` : ""} ` +
        `| ${turn.completeSearch ? "yes" : "no"} | ${turn.results.length} | ${sources} | ${chars} |`,
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

  parts.push(
    "",
    "## Every LLM call, in order",
    "",
    "`prompt chars` is the size of the message list handed to the model — the direct measure",
    "of history growth, independent of the provider reporting usage.",
    "",
    "| # | Tier | Prompt msgs | Prompt chars | Input tokens | Output tokens | ms |",
    "|---|---|---|---|---|---|---|",
  );

  for (const call of calls) {
    parts.push(
      `| ${call.seq} | ${call.tier} | ${call.promptMessages} | ${call.promptChars} ` +
        `| ${call.inputTokens ?? ""} | ${call.outputTokens ?? ""} | ${call.durationMs} |`,
    );
  }

  parts.push("", "## Cost by tier", "", "| Tier | Calls | Input tokens | Output tokens | Approx USD |", "|---|---|---|---|---|");

  let grand = 0;
  for (const tier of ["full", "mini", "nano"] as Tier[]) {
    const tierCalls = calls.filter((c) => c.tier === tier);
    if (!tierCalls.length) continue;
    const inTokens = total(tier, "inputTokens");
    const outTokens = total(tier, "outputTokens");
    const usd = (inTokens * PRICES[tier].in + outTokens * PRICES[tier].out) / 1_000_000;
    grand += usd;
    parts.push(`| ${tier} | ${tierCalls.length} | ${inTokens} | ${outTokens} | $${usd.toFixed(4)} |`);
  }
  parts.push(`| **total** | ${calls.length} | | | **$${grand.toFixed(4)}** |`);
  parts.push("", "_Prices are the approximate published per-1M-token rates hardcoded in this harness._");

  return parts.filter((line) => line !== "").join("\n") + "\n";
};

// ============================================================ MAIN ============================================================

async function main() {
  const topic = process.argv.slice(2).filter((arg) => !arg.startsWith("-")).join(" ").trim() || DEFAULT_TOPIC;

  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length) {
    out(`Missing required environment variable(s): ${missing.join(", ")}`);
    out("Add them to .env in the project root — see CLAUDE.md for the full key list.");
    process.exit(1);
  }

  // Both imports are dynamic and ordered: model.ts builds its ChatOpenAI instances at module
  // scope and throws on a missing key, so the check above has to run first. Patching the tiers
  // before researchAgent loads also covers nanoModel.bindTools(), which runs at that module's
  // scope — the binding keeps a reference to the object, so it still resolves the wrapper.
  const models = await import("../model.js");
  patchModel(models.fullModel as unknown as Patchable, "full");
  patchModel(models.miniModel as unknown as Patchable, "mini");
  patchModel(models.nanoModel as unknown as Patchable, "nano");

  // Must run before researchAgent loads: its module scope calls nanoModel.bindTools() once,
  // and only a wrapper installed by then sees the clone that call returns.
  patchBindTools(models.nanoModel as unknown as BindsTools, "nano");
  patchBindTools(models.fullModel as unknown as BindsTools, "full");
  patchBindTools(models.miniModel as unknown as BindsTools, "mini");

  const { researchAgent } = await import("../researchAgent.js");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(TRACE_ROOT, `${stamp}-researcher`);
  mkdirSync(runDir, { recursive: true });

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
          appendFileSync(updatesPath, `${JSON.stringify({ step, node, delta: encodeDelta(delta) })}\n`);
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
