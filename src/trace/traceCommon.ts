/**
 * Machinery shared by the trace harnesses in this folder (`traceResearcher.ts`,
 * `traceSupervisor.ts`). Nothing in `src/` outside `src/trace/` imports any of it.
 *
 * It exists because both harnesses observe an agent the same way — stream the graph for state
 * deltas, and wrap `invoke` on the model singletons to see every LLM call — and the awkward
 * parts of doing that (which usage field a langchain version populates, the fact that
 * `bindTools()` hands back a clone rather than a delegating binding) are worth getting wrong
 * in only one place.
 *
 * What is deliberately *not* here: how a run is summarised. Each agent's report is written
 * against its own state shape and turn structure, so `buildSummary`/`buildTranscript` live in
 * the harness that owns them.
 */
import "dotenv/config";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

export const TRACE_ROOT = join(process.cwd(), "traces");
export const REQUIRED_KEYS = ["OPENAI_API_KEY", "TAVILY_API_KEY"];

export const out = (text = "") => process.stdout.write(`${text}\n`);
export const RULE = "─".repeat(78);

export const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * Exits with a usable message rather than letting `model.ts` throw from its module scope.
 * Must be called before the dynamic `import("../model.js")` in a harness, because that module
 * builds its ChatOpenAI instances at module scope.
 */
export const requireEnv = (keys: string[] = REQUIRED_KEYS) => {
  const missing = keys.filter((key) => !process.env[key]);
  if (!missing.length) return;

  out(`Missing required environment variable(s): ${missing.join(", ")}`);
  out("Add them to .env in the project root — see CLAUDE.md for the full key list.");
  process.exit(1);
};

/**
 * Output lands in a folder under traces/ named for the start time, the pid and the agent,
 * which is gitignored. The pid is in the name because two runs launched together get the same
 * ISO timestamp to the millisecond — observed — and then share one directory, which
 * interleaves updates.jsonl and leaves whichever run finishes last owning summary.md.
 */
export const makeRunDir = (agent: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(TRACE_ROOT, `${stamp}-pid${process.pid}-${agent}`);
  mkdirSync(runDir, { recursive: true });
  return runDir;
};

// ============================================================ LLM CALL RECORDING ============================================================

export type Tier = "full" | "mini" | "nano";

// Approximate published USD prices per 1M tokens, for an order-of-magnitude total only.
// Re-check before quoting these anywhere that matters.
export const PRICES: Record<Tier, { in: number; out: number }> = {
  full: { in: 2.0, out: 8.0 }, // gpt-4.1
  mini: { in: 0.4, out: 1.6 }, // gpt-4.1-mini
  nano: { in: 0.2, out: 1.25 }, // gpt-5.4-nano
};

export type CallRecord = {
  seq: number;
  tier: Tier;
  // Which caller made the call, when the harness supplies a classifier. The researcher
  // harness traces one agent and leaves this null; the supervisor harness needs it because
  // the model singletons it patches also serve every researcher it spawns.
  owner: string | null;
  startedAt: number;
  durationMs: number;
  promptMessages: number;
  promptChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: string | null;
};

export const calls: CallRecord[] = [];

export const charsOf = (content: unknown): number => {
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
export const readUsage = (result: unknown): { in: number | null; out: number | null; source: string | null } => {
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

export type Patchable = { invoke: (...args: unknown[]) => Promise<unknown> };
export type BindsTools = { bindTools: (...args: unknown[]) => unknown };

/**
 * Names the caller from the prompt it sent. Receives the message list as handed to `invoke`,
 * and returns a label or null for "could not tell".
 */
export type CallClassifier = (messages: unknown[]) => string | null;

/**
 * Wraps `invoke` on one model singleton. `promptChars` is recorded alongside the token
 * count because it needs no provider cooperation — if usage metadata ever comes back empty
 * the growth curve is still measurable.
 */
export const patchModel = (model: Patchable, tier: Tier, classify?: CallClassifier) => {
  const original = model.invoke.bind(model);

  model.invoke = async (...args: unknown[]) => {
    const input = args[0];
    const messages: unknown[] = Array.isArray(input) ? input : [input];
    const startedAt = Date.now();

    // Classified before awaiting, so an owner is recorded even if the call throws later, and
    // so the classifier sees the prompt as sent rather than anything mutated meanwhile.
    const owner = classify ? classify(messages) : null;

    const result = await original(...args);

    const usage = readUsage(result);
    calls.push({
      seq: calls.length + 1,
      tier,
      owner,
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
export const patchBindTools = (model: BindsTools, tier: Tier, classify?: CallClassifier) => {
  const original = model.bindTools.bind(model);

  model.bindTools = (...args: unknown[]) => {
    const bound = original(...args);
    patchModel(bound as Patchable, tier, classify);
    return bound;
  };
};

/**
 * Patches all three tiers and their `bindTools`, which is what every harness wants.
 *
 * Call this before importing any agent module: an agent's module scope may call
 * `bindTools()` (both `researchAgent` and `supervisorAgent` do), and only a wrapper
 * installed by then sees the clone that call returns. The binding keeps a reference to the
 * model object, so patching `invoke` beforehand still resolves the wrapper.
 */
export const patchModelTiers = (
  models: { fullModel: unknown; miniModel: unknown; nanoModel: unknown },
  classify?: CallClassifier,
) => {
  const tiers: [unknown, Tier][] = [
    [models.fullModel, "full"],
    [models.miniModel, "mini"],
    [models.nanoModel, "nano"],
  ];

  for (const [model, tier] of tiers) {
    patchModel(model as Patchable, tier, classify);
    patchBindTools(model as BindsTools, tier, classify);
  }
};

// ============================================================ ENCODING ============================================================

export type EncodedMessage = {
  type: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls: { name: string; id?: string; args: unknown }[];
  chars: number;
  content: string;
};

/**
 * Anything that reaches the encoder: a real BaseMessage, or one of the plain message dicts a
 * node returns instead.
 *
 * The dicts are not hypothetical — `supervisor_tool_node` returns its results as
 * `{role: "tool", content, tool_call_id}` rather than ToolMessage instances. LangGraph coerces
 * them when it applies the update, so the *state* only ever holds BaseMessages, but the
 * "updates" stream hands over each node's return value as it was returned. An encoder that
 * assumes `getType()` therefore dies on the supervisor's first tool node — observed.
 */
type MessageLike = {
  getType?: () => string;
  _getType?: () => string;
  role?: string;
  type?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { name: string; id?: string; args: unknown }[];
  content?: unknown;
};

const typeOf = (message: MessageLike): string => {
  if (typeof message.getType === "function") return message.getType();
  if (typeof message._getType === "function") return message._getType();
  return message.role ?? message.type ?? "unknown";
};

// BaseMessage.toJSON() exists but emits a deep serialisation envelope that buries the fields
// this analysis is about, so encode the interesting parts by hand instead.
export const encodeMessage = (message: BaseMessage | MessageLike): EncodedMessage => ({
  type: typeOf(message as MessageLike),
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

// `messagesKey` is the state's messages channel — `researcher_messages` or
// `supervisor_messages` — the one field in a node's delta that needs encoding rather than
// passing through as JSON.
export const encodeDelta = (delta: unknown, messagesKey: string) => {
  if (!delta || typeof delta !== "object") return delta ?? null;

  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
    encoded[key] =
      key === messagesKey && Array.isArray(value)
        ? value.map((m) => encodeMessage(m as BaseMessage))
        : value;
  }
  return encoded;
};

// With a multi-mode streamMode LangGraph yields [mode, payload] tuples. The shape is
// verified against the first chunk at runtime rather than assumed, and reported in the
// summary, so a version change shows up as a note instead of a silently empty trace.
export const decodeChunk = (chunk: unknown): { mode: string; payload: unknown } => {
  if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
    return { mode: chunk[0], payload: chunk[1] };
  }
  return { mode: "unknown", payload: chunk };
};

// ============================================================ COST REPORTING ============================================================

export const usageSourceLabel = (records: CallRecord[] = calls): string => {
  const sources = [...new Set(records.map((c) => c.usageSource).filter(Boolean))];
  return sources.length ? sources.join(", ") : "nothing populated — token columns are blank";
};

export const usdFor = (records: CallRecord[]): number =>
  records.reduce(
    (sum, c) =>
      sum + ((c.inputTokens ?? 0) * PRICES[c.tier].in + (c.outputTokens ?? 0) * PRICES[c.tier].out) / 1_000_000,
    0,
  );

/**
 * The per-call table. `withOwner` adds the attribution column; a harness that traces a single
 * agent leaves it off, since every row would say the same thing.
 */
export const callsTable = (records: CallRecord[] = calls, withOwner = false): string[] => {
  const lines = [
    "## Every LLM call, in order",
    "",
    "`prompt chars` is the size of the message list handed to the model — the direct measure",
    "of history growth, independent of the provider reporting usage.",
    "",
    withOwner
      ? "| # | Owner | Tier | Prompt msgs | Prompt chars | Input tokens | Output tokens | ms |"
      : "| # | Tier | Prompt msgs | Prompt chars | Input tokens | Output tokens | ms |",
    withOwner ? "|---|---|---|---|---|---|---|---|" : "|---|---|---|---|---|---|---|",
  ];

  for (const call of records) {
    const owner = withOwner ? `| ${call.owner ?? "unknown"} ` : "";
    lines.push(
      `| ${call.seq} ${owner}| ${call.tier} | ${call.promptMessages} | ${call.promptChars} ` +
        `| ${call.inputTokens ?? ""} | ${call.outputTokens ?? ""} | ${call.durationMs} |`,
    );
  }

  return lines;
};

export const tierCostTable = (records: CallRecord[] = calls): string[] => {
  const lines = ["", "## Cost by tier", "", "| Tier | Calls | Input tokens | Output tokens | Approx USD |", "|---|---|---|---|---|"];

  let grand = 0;
  for (const tier of ["full", "mini", "nano"] as Tier[]) {
    const tierCalls = records.filter((c) => c.tier === tier);
    if (!tierCalls.length) continue;
    const inTokens = tierCalls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0);
    const outTokens = tierCalls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0);
    const usd = usdFor(tierCalls);
    grand += usd;
    lines.push(`| ${tier} | ${tierCalls.length} | ${inTokens} | ${outTokens} | $${usd.toFixed(4)} |`);
  }
  lines.push(`| **total** | ${records.length} | | | **$${grand.toFixed(4)}** |`);
  lines.push("", "_Prices are the approximate published per-1M-token rates hardcoded in `traceCommon.ts`._");

  return lines;
};
