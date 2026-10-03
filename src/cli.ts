/**
 * A chat-style CLI for the conversation graph.
 *
 * Deliberately knows nothing about the agents beyond two things: the message stream and
 * whether the graph is paused at an interrupt. No agent file is modified or read for state —
 * `messages` is the display, `tasks[].interrupts` is the control flow. That is the whole
 * contract, and it is the same one documented in CLAUDE.md for any UI in front of this graph.
 *
 * Run it with `npm run cli` (add `-- --verbose` to see the agents' own console output inline
 * instead of in cli.log, and `-- "your topic"` to skip the opening prompt).
 *
 * One topic per process: when the graph reaches END the report is saved and the CLI exits,
 * because `notes` uses an append reducer and a second research run on the same thread_id
 * would splice the first report's findings into the next one.
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";

import { Command } from "@langchain/langgraph";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";

// The graph is imported dynamically (see main) so the API-key check runs first: model.ts
// constructs its ChatOpenAI instances at module scope and throws on a missing key, which
// would beat a static import's guard to the punch.
type ConversationGraph = typeof import("./conversationAgent.js")["conversationGraph"];

const LOG_FILE = join(process.cwd(), "cli.log");
const REPORT_DIR = join(process.cwd(), "reports");
const REQUIRED_KEYS = ["OPENAI_API_KEY", "TAVILY_API_KEY"];

// ============================================================ OUTPUT ============================================================
// Everything the CLI prints goes through `out`, never console.log — console.log is patched
// below to divert the agents' own logging to a file, and the CLI must not divert itself.

const TTY = process.stdout.isTTY === true;

const out = (text = "") => process.stdout.write(`${text}\n`);

const paint = (code: string) => (text: string) => (TTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = paint("36;1");
const dim = paint("2");
const red = paint("31");

/**
 * Sends the agents' console output to cli.log instead of the chat.
 *
 * `console.log` is looked up on the global object at call time, so replacing it here also
 * captures the calls already compiled into conversationAgent/supervisorAgent/researchAgent —
 * no agent code has to change. console.error is left alone: a genuine library error is worth
 * seeing on screen.
 */
const patchConsole = () => {
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
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${level} ${args.map(format).join(" ")}\n`);
    } catch {
      // A broken log file must never take the chat down with it.
    }
  };

  console.log = toFile("log");
  console.info = toFile("info");
  console.debug = toFile("debug");
  console.warn = toFile("warn");
};

const logError = (err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] error ${detail}\n`);
  } catch {
    // ignore
  }
};

// ============================================================ STATUS LINE ============================================================

// Friendly label per node, across all three graphs. An unmapped node falls back to "Working…"
// rather than throwing, so adding a node later degrades instead of breaking. The two
// interrupting nodes map to "" — they stop the graph immediately, so labelling them would
// just flash text at the user.
const PHASE_LABELS: Record<string, string> = {
  scope_topic: "Reading your request…",
  ask_user: "",
  propose_plan: "Drafting a research plan…",
  confirm_plan: "",
  classify_feedback: "Considering your feedback…",
  dispatch_research: "Handing off to the research team…",
  supervisor_agent: "Planning research assignments…",
  supervisor_node: "Planning research assignments…",
  supervisor_tool_node: "Researchers working…",
  research_node: "Deciding what to search for…",
  research_tool_node: "Searching the web…",
  compression_node: "Summarising findings…",
  report_generator: "Writing the report…",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const elapsed = (since: number) => {
  const total = Math.round((Date.now() - since) / 1000);
  const mins = Math.floor(total / 60);
  return mins ? `${mins}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
};

/**
 * One ephemeral line, overwritten in place, cleared before anything else prints.
 *
 * Falls back to a plain line per phase change when stdout is not a TTY (piped output) or
 * when --verbose is on, since the agents' own logging would otherwise fight the spinner for
 * the same line.
 */
class StatusLine {
  private label = "Working…";
  private frame = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly animate: boolean) {}

  start() {
    this.startedAt = Date.now();
    this.frame = 0;
    if (this.animate) {
      this.timer = setInterval(() => this.draw(), 120);
      this.timer.unref();
    }
  }

  set(label: string) {
    if (!label || label === this.label) return;
    this.label = label;
    if (this.animate) this.draw();
    else out(dim(`  · ${label}`));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.animate) process.stdout.write("\r\x1b[2K");
  }

  private draw() {
    const spin = SPINNER[this.frame++ % SPINNER.length];
    process.stdout.write(`\r\x1b[2K${dim(`  ${spin} ${this.label}  ${elapsed(this.startedAt)}`)}`);
  }
}

// ============================================================ GRAPH PLUMBING ============================================================

/**
 * Pulls the node name out of a `streamMode: "tasks"` chunk, but only for task *starts*.
 *
 * "tasks" is used rather than "updates" because it fires when a node begins rather than when
 * it finishes — an updates-driven status line always names the step that just ended. Start
 * and result events are distinguished by `result`, which only the latter carries. With
 * `subgraphs: true` the chunk is a [namespace, payload] tuple; the namespace is ignored,
 * since the node name alone picks the label.
 */
const startedNode = (chunk: unknown): string | undefined => {
  const payload = Array.isArray(chunk) ? chunk[chunk.length - 1] : chunk;
  if (!payload || typeof payload !== "object") return undefined;

  const task = payload as { name?: unknown; result?: unknown };
  if ("result" in task) return undefined;
  if (typeof task.name !== "string" || task.name.startsWith("__")) return undefined;

  return task.name;
};

type Turn = {
  /** True when the graph is parked on an interrupt() and wants free text back. */
  interrupted: boolean;
  /** True when the graph ran to END. */
  finished: boolean;
  messages: BaseMessage[];
  finalReport: string;
};

const snapshotTurn = async (graph: ConversationGraph, config: { configurable: { thread_id: string } }): Promise<Turn> => {
  const snapshot = await graph.getState(config);
  const values = snapshot.values as { messages?: BaseMessage[]; final_report?: string };

  return {
    // Read off the interrupts rather than `next`: after a failed node `next` is non-empty too,
    // and answering that with a Command({ resume }) would be wrong — nothing is waiting.
    interrupted: snapshot.tasks.some((task) => (task.interrupts?.length ?? 0) > 0),
    finished: snapshot.next.length === 0,
    messages: values.messages ?? [],
    finalReport: values.final_report ?? "",
  };
};

/** Runs one turn to its next pause, driving the status line off the task stream. */
const runTurn = async (
  graph: ConversationGraph,
  config: { configurable: { thread_id: string }; recursionLimit: number },
  input: unknown,
  status: StatusLine,
) => {
  status.start();
  try {
    const stream = await graph.stream(input as never, { ...config, streamMode: "tasks", subgraphs: true });
    for await (const chunk of stream) {
      const node = startedNode(chunk);
      if (node) status.set(PHASE_LABELS[node] ?? "Working…");
    }
  } finally {
    status.stop();
  }
};

// ============================================================ CHAT ============================================================

const printAi = (text: string) => {
  out();
  out(cyan("AI"));
  out(text);
  out();
};

const banner = () => {
  out();
  out(cyan("  War Research") + dim(" — deep research on armed conflicts"));
  out(dim("  Type a topic to begin. /help for commands."));
  out();
};

const help = () => {
  out();
  out(dim("  /retry   resume the run from its last checkpoint after an error"));
  out(dim("  /help    this list"));
  out(dim("  /exit    quit (Ctrl-C and Ctrl-D also work)"));
  out(dim(`  Agent logs go to ${LOG_FILE} — pass --verbose to see them here instead.`));
  out();
};

const saveReport = (report: string) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(REPORT_DIR, `${stamp}.md`);
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(file, report.endsWith("\n") ? report : `${report}\n`, "utf8");
    out(dim(`  Saved to ${file}`));
  } catch (err) {
    logError(err);
    out(dim(`  Could not save the report to ${file} — see ${LOG_FILE}.`));
  }
};

/**
 * Reads one line, resolving to undefined at end of input (Ctrl-D, or a closed pipe).
 *
 * Pulls from readline's async iterator rather than calling rl.question(): the iterator pauses
 * the underlying stream between reads, so piped input (`echo topic | npm run cli`) is consumed
 * a line at a time instead of being buffered and dropped when the stream closes. Writing the
 * prompt by hand is the only thing question() was doing for us.
 */
const makeReader = (rl: Interface) => {
  const lines = rl[Symbol.asyncIterator]();

  return async (prompt: string): Promise<string | undefined> => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) {
      out();
      return undefined;
    }
    return String(value);
  };
};

// ============================================================ MAIN ============================================================

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const opening = args.filter((arg) => !arg.startsWith("-")).join(" ").trim();

  if (!verbose) patchConsole();

  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length) {
    out(red(`Missing required environment variable(s): ${missing.join(", ")}`));
    out(dim("Add them to .env in the project root — see CLAUDE.md for the full key list."));
    process.exit(1);
  }

  const { conversationGraph: graph } = await import("./conversationAgent.js");

  const config = { configurable: { thread_id: randomUUID() } };
  // The default recursion limit is 25, which the supervisor and researcher loops can reach on
  // a long negotiation followed by a full research run.
  const runConfig = { ...config, recursionLimit: 100 };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const read = makeReader(rl);
  const status = new StatusLine(TTY && !verbose);

  let busy = false;
  rl.on("SIGINT", () => {
    out();
    // Mid-turn there is nothing to unwind gracefully — the graph is inside an LLM call.
    if (busy) process.exit(130);
    rl.close();
  });

  banner();

  let pending: string | undefined = opening || undefined;
  let printed = 0; // messages already shown
  let interrupted = false; // graph is waiting for free text
  let failed = false; // last turn threw, so /retry means something

  for (;;) {
    const line = pending ?? (await read("you › "));
    pending = undefined;
    if (line === undefined) break; // Ctrl-D

    const text = line.trim();
    if (!text) continue;

    let input: unknown;

    if (text.startsWith("/")) {
      const command = text.toLowerCase();
      if (command === "/exit" || command === "/quit") break;
      if (command === "/help") {
        help();
        continue;
      }
      if (command === "/retry") {
        if (!failed) {
          out(dim("  Nothing to retry."));
          continue;
        }
        // null resumes the run from its last checkpoint instead of replaying the turn.
        input = null;
      } else {
        out(dim(`  Unknown command ${text} — /help for the list.`));
        continue;
      }
    } else {
      input = interrupted ? new Command({ resume: text }) : { messages: [new HumanMessage(text)] };
    }

    busy = true;
    let turn: Turn;
    try {
      await runTurn(graph, runConfig, input, status);
      turn = await snapshotTurn(graph, config);
      failed = false;
    } catch (err) {
      logError(err);
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      out(red(`  ⚠ ${message}`));
      out(dim(`  Details in ${LOG_FILE}. /retry resumes from the last checkpoint.`));
      // Re-read the graph so the next line is sent the right way even after a failure.
      interrupted = await snapshotTurn(graph, config).then((t) => t.interrupted).catch(() => false);
      continue;
    } finally {
      busy = false;
    }

    for (const message of turn.messages.slice(printed)) {
      if (message.getType() === "ai") printAi(String(message.content));
    }
    printed = turn.messages.length;

    interrupted = turn.interrupted;
    if (interrupted) continue;

    if (turn.finished) {
      // Both END routes land here: a finished report, and scope_topic's give-up path, which
      // has already said its piece as an AI message and leaves final_report empty.
      if (turn.finalReport) saveReport(turn.finalReport);
      break;
    }

    out(dim("  The run stopped without asking anything. /retry resumes it."));
    failed = true;
  }

  rl.close();
}

main().catch((err) => {
  logError(err);
  out(red(`  ⚠ ${err instanceof Error ? err.message : String(err)}`));
  out(dim(`  Details in ${LOG_FILE}.`));
  process.exit(1);
});
