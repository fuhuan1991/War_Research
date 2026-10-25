# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # tsc compile to dist/
npm run cli                # chat with the pipeline in a terminal (real API calls — a full research run)
npm run dev                # npx @langchain/langgraph-cli@1.5.2 dev — starts LangGraph Studio dev server
npm test                   # vitest run tests/unit (mocked, no API calls)
npm run llm-test           # vitest run tests/eval (real OpenAI + Tavily calls, LLM-as-judge assertions)
npm run llm-test:conversation  # just the pre-research eval — no researchers spawned, so far cheaper than the rest of tests/eval

npm run trace:researcher   # trace one researchAgent run to traces/ (real API calls)
npm run trace:supervisor   # trace one supervisorAgent run to traces/ (real API calls — the most expensive script here)

# Single test file
npx vitest run tests/unit/researchAgent.test.ts
npx vitest run tests/eval/researchAgent.eval.test.ts

# CLI flags — npm forwards only what follows the `--`
npm run cli -- --verbose              # agents' own console output inline instead of in cli.log
npm run cli -- --html                 # also render the report as HTML and open it (macOS)
npm run cli -- "the siege of Malta"   # skip the opening prompt

# Single test case
npx vitest run tests/unit/researchAgent.test.ts -t "test name substring"
```

The `dev` script pins `@langchain/langgraph-cli` to an exact version on purpose. It used to be
`@latest`, which re-resolved the CLI on every single run, so a CLI release could change this
project's behaviour with nothing in the repo having changed — which is exactly what happened
when CLI 1.5.2 raised its required `@langchain/langgraph` range to `^1.4.18-rc.0` and `npm run
dev` began warning that the lockfile's 1.4.17 was out of date. Bumping the pin is now a
deliberate act: when you raise it, check the new CLI's required `@langchain/langgraph` range
(`npm view @langchain/langgraph-cli@<version> dependencies`, then the `@langchain/langgraph-api`
peer range) against what the lockfile actually resolves, and move the dependency in the same
commit. Note the required range may name an `-rc` version as its floor, as `^1.4.18-rc.0` does;
that is a lower bound, not a demand for a release candidate — any later stable release satisfies it.

Requires a `.env` in the project root. A local `.env.example` exists, but both it and `.env` are gitignored, so neither reaches a fresh clone — the keys are listed here instead:

```bash
OPENAI_API_KEY=       # required — every model routes through ChatOpenAI (src/model.ts)
TAVILY_API_KEY=       # required — web search (src/tools/tavilySearch.ts)
ANTHROPIC_API_KEY=    # unused today; no model routes through Anthropic
LANGSMITH_API_KEY=    # optional — tracing
LANGSMITH_TRACING=
LANGSMITH_PROJECT=war-research
DOTENV_CONFIG_QUIET=true  # silences the dotenv v17+ "injected env ... from .env" startup banner
```

`tests/eval/*` make real LLM and Tavily calls and cost money/time — only run when explicitly needed, not as part of routine iteration.

## Project docs

- `TODO.md` — the authoritative backlog. **Read it before proposing work.** It already tracks the known gaps (unenforced `MAX_CONCURRENT_RESEARCH_UNITS`, `Promise.all` failure isolation, dead `raw_notes`, iteration-limit off-by-one, missing README/CI/linter), so they don't need re-deriving from a fresh scan.
- `docs/question-flow.md` — annotated mermaid flow of the whole pipeline, including which model tier each node uses and where the graph pauses for the user. Check it before changing routing logic.
- `conversation_plan.md` — node-level design doc for the scoping / plan-confirmation loop that now forms the front half of `src/conversationAgent.ts`.

## Architecture

This is a war-focused deep research agent (LangGraph.js). The pipeline is three nested graphs that mirror a lead-researcher/sub-researcher pattern. The top-level graph negotiates a research plan with the user and gets explicit approval before any research is spent:

```
conversationGraph (src/conversationAgent.ts)   — top-level graph, holds the checkpointer
  scope_topic ⇄ ask_user → propose_plan → confirm_plan → classify_feedback
    → dispatch_research → supervisor_agent (subgraph) → report_generator
                                              │
                                              ▼
supervisorAgent (src/supervisorAgent.ts)     — one instance per conversation
  supervisor_node ⇄ supervisor_tool_node
    → spawns researchAgent × N in parallel (Promise.all), one per ConductResearch call
    → loops back to supervisor_node until CompleteResearch or MAX_SUPERVISOR_TURNS
                                              │
                                              ▼
researchAgent (src/researchAgent.ts)         — one instance per research topic
  research_node ⇄ research_tool_node → compression_node
    → research_tool_node runs TavilySearch × N in parallel, loops back to research_node
    → until CompleteSearch or MAX_RESEARCHER_TURNS, then compresses findings
```

`langgraph.json` registers all three graphs independently, so each can be run and visualized on its own in LangGraph Studio, not just as a whole.

### The assess → dispatch pattern

Both `supervisorAgent` and `researchAgent` split each turn into two LLM calls instead of one:
1. **Assess** (`fullModel`, gpt-4.1) — reasons over state in prose, appended as an `AIMessage`.
2. **Dispatch** (`nanoModel`, gpt-5.4-nano, `tool_choice: "required"`) — forced to emit a tool call based on the assessment, decoupling "thinking" from "acting" so the cheap model only has to pick a tool, not reason.

`miniModel` (gpt-4.1-mini) is reserved for cheaper structured-output work: `classify_feedback` and per-page `summarizeWebpage`.

### Routing via `Command`, not conditional edges

Every node that needs to branch returns `new Command({ goto, update })` rather than relying on `addConditionalEdges`. Graph builders declare the possible destinations via `{ ends: [...] }` on `addNode` for LangGraph Studio's benefit, but the actual branching logic lives inside the node function.

### Tools are never executed by the LLM-facing tool object

`ConductResearch`/`CompleteResearch` (supervisor) and `TavilySearch`/`CompleteSearch` (researcher) are defined with `tool()` purely so their schema can be bound to the dispatching model — their `func` bodies are stubs. The real side effects (spawning a sub-agent, calling Tavily) happen in the paired `*_tool_node` function, which reads `tool_calls` off the last `AIMessage` and constructs `ToolMessage`s manually. When adding a new tool, follow this split rather than putting logic in the `tool()` call itself.

### State shape

States are zod schemas wrapped in `withLangGraph` (`src/states/*.ts`). The project is pinned to **zod 3** (`^3.25.76`) on purpose — do not bump it to 4 without reading this paragraph.

Every messages channel is declared `withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta)`, the pattern LangGraph documents. `MessagesZodMeta` is written against zod 3, and under **zod 4 that declaration is fatal**: `z.custom()` is unrepresentable in zod 4's native `toJSONSchema`, which throws `Custom types cannot be represented in JSON Schema`. `@langchain/core`'s `toJsonSchema` calls it with no `unrepresentable: "any"` escape, so the throw propagates, the dev server publishes **no state or input schema for any graph**, and LangGraph Studio reports `create a graph with messages key to chat with` — the chat tab disappears from all three graphs. Nothing else fails visibly, which makes it hard to trace. Under zod 3 the same declaration routes through `zodToJsonSchema`, which treats `z.custom()` as `ZodAny` and emits `{}`, preserving the `langgraph_type: "messages"` marker Studio keys on.

If you do need zod 4, the fix is to replace `z.custom<BaseMessage[]>()` with `z.array(z.any()) as unknown as z.ZodType<BaseMessage[]>` in all four places (`conversationState.ts` ×2, `supervisorState.ts`, `researcherState.ts`). It serializes cleanly, keeps the marker, and is strictly stricter at runtime than `z.custom()`, which accepts anything. Note also that zod 4 emits a `"$schema": "https://json-schema.org/draft/2020-12/schema"` key inside the `parameters` object of every tool/structured-output schema sent to OpenAI; that was accepted by the live API when last checked with `npm run llm-test`, but it is the first thing to check if tool calls start being rejected.

- Message fields (`messages`, `supervisor_messages`, `researcher_messages`) use `MessagesZodMeta` for LangGraph's built-in message-append reducer.
- `notes`/`raw_notes` use a custom `(a, b) => [...a, ...b]` reducer so parallel branches (parallel researchers, parallel searches) merge without clobbering each other.
- `research_iterations` is a plain counter checked against `MAX_SUPERVISOR_TURNS`/`MAX_RESEARCHER_TURNS` (`src/config.ts`) to force termination. `clarify_rounds`/`confirm_rounds` do the same job for the pre-research loops against `MAX_CLARIFY_ROUNDS`/`MAX_CONFIRM_ROUNDS`.
- **There is no `research_brief`.** The confirmed `plan` (`{ final_topic, angles }`, schema in `src/plan.ts`) is the single artifact handed to the research phase. `planToBrief()` renders it to prose in the two places a string is needed: the `HumanMessage` seeding `supervisor_messages`, and the `{research_plan}` slot in `reportGeneratorPrompt`. Change the rendering in one place, not two.
- Non-message fields that a node reads back must declare their default via `withLangGraph(..., { default })`, not zod's `.default()`. LangGraph builds its channels from the registry metadata, so a plain `z.number().default(0)` reads back as `undefined` inside a node and `state.counter + 1` silently becomes `NaN` (see the note at the top of `src/states/conversationState.ts`).

Prompt templates are filled with `fillTemplate` (`src/prompts/fillTemplate.ts`), never a
chain of `.replace("{slot}", value)`. Two reasons, both reachable from content the system
does not control — the values include the user's own messages and Tavily-scraped page text:
a string replacement expands `$&` / `$'` / `` $` `` (a single `$'` in a search result
spliced the remainder of the prompt into itself), and chained calls re-scan text that
earlier calls injected, so a value containing a later placeholder captured that
substitution. `fillTemplate` substitutes every slot in one pass through a replacer
function, which is immune to both. Regression tests in `tests/unit/fillTemplate.test.ts`.

Synthetic control-flow `ToolMessage`s (e.g. `"<Research completed>"`) are wrapped in angle brackets by convention; `compression_node` filters these out via `.startsWith("<")` when extracting real `raw_notes`, so preserve that convention if you add new synthetic messages.

### The pre-research phase — scoping and plan confirmation (human-in-the-loop)

The front half of `conversationAgent.ts` is a negotiation loop, not a one-shot classifier: scope the topic, propose a plan (final topic + up to `MAX_ANGLES_PER_PLAN` angles), and get explicit user approval before any research is spent.

```
START → scope_topic ⇄ ask_user          (nudge the user until the topic is workable)
              │
              ▼
        propose_plan → confirm_plan → classify_feedback → dispatch_research → …
              ▲                               │
              └───────────────────────────────┘   (angle-level feedback replans; topic-level restarts scoping)
```

- Both loops are bounded. `scope_topic` gives up after `MAX_CLARIFY_ROUNDS` nudges (routes to `END`); `propose_plan` auto-accepts the next plan after `MAX_CONFIRM_ROUNDS` rejections. Only angle-level feedback spends a confirmation round — approving costs nothing.
- Off-topic and too-vague share the `ask_user` path. The `off_topic` status only changes the wording of the nudge, not the routing, so a "trade war" question gets redirected toward a real conflict rather than rejected outright.
- `dispatch_research` is the seam between the two halves: a no-LLM node that renders `plan` into the seed `HumanMessage`. Both routes into research (an approval, and the round-cap auto-accept) go through it, so there is exactly one place to change when wiring the supervisor to dispatch one researcher per approved angle.
- Design doc: `conversation_plan.md`.

**The `interrupt()` rule.** The graph pauses for the user with LangGraph's `interrupt()`, which is why the top-level graph holds the checkpointer. A node that calls `interrupt()` **re-executes from the top on resume**, so:

- Never mix an LLM call and an `interrupt()` in one node. `ask_user` and `confirm_plan` are interrupt-only; `scope_topic`, `propose_plan` and `classify_feedback` are LLM-only. Preserve that split when adding nodes — a mixed node would re-fire its LLM call on every resume.
- Anything an interrupting node needs on resume must live in state, never in a local variable. This is why `propose_plan` writes `plan` to state *before* `confirm_plan` pauses — `confirm_plan` itself holds nothing, and `classify_feedback` reads the proposal back out of `messages`.
- Resume contract: both interrupting nodes take **free text**, resumed with `new Command({ resume: "..." })` on the same `thread_id`. `ask_user`'s reply feeds `scope_topic`; `confirm_plan`'s reply is appended to `messages` and handed to `classify_feedback`, which decides approve / angle-revision / topic-restart. `confirm_plan` deliberately does no interpretation of its own — reading "approve" needs an LLM, and an interrupting node cannot hold one. Both nodes also render their question into `messages` before pausing (`scope_topic` writes the nudge, `propose_plan` writes the plan plus the confirmation question), so a chat UI showing only the message stream sees what is being asked.
- This is a caller-visible contract: a paused run is resumed, not re-invoked with a new message. Any HTTP surface in front of this graph needs a resume endpoint.

### Dependency injection for testing

`conversationAgent.ts` node factories (`makeScopeTopicNode(llm)`, `makeProposePlanNode(llm)`, `makeClassifyFeedbackNode(llm)`, `makeReportGenerator(llm)`) take the model as a parameter so tests can inject a fake. The nodes with no LLM call — `askUserNode`, `confirmPlanNode`, `dispatchResearchNode` — are exported directly. `supervisorAgent.ts`/`researchAgent.ts` node factories instead import `fullModel`/`nanoModel` from `src/model.ts` directly at module scope; unit tests mock that whole module with `vi.mock("../../src/model.js", ...)` plus `vi.hoisted` (see `tests/unit/researchAgent.test.ts`) rather than injecting.

**`tests/eval/conversationAgent.eval.test.ts` duplicates the graph wiring, and nothing guards the copy.** It exercises the real exported nodes with the real models, but hand-assembles its own `StateGraph` in which `dispatch_research` routes to `END` instead of to `supervisor_agent` → `report_generator` — that is what keeps approving a plan down to a handful of cheap calls instead of spawning up to `MAX_ANGLES_PER_PLAN` researchers and their Tavily searches. The cost of that trick is a second copy of the wiring: add, remove, rename or re-route a node in `conversationAgent.ts` and the eval keeps passing while silently testing a graph that no longer exists. Mirror every such change there. Run it alone with `npm run llm-test:conversation`.

The one block in that file which does **not** use the mirrored graph is the angle-quality
suite at the bottom: it calls `makeProposePlanNode` directly against a seeded state, so it
is immune to the drift above and costs one `fullModel` call per seed. It scores the angles
`propose_plan` invents using the four LLM judges in `tests/eval/angleJudges.ts`. Read that
file's header before touching a judge prompt — each judge is calibrated two-sided (a known-bad
plan must be rejected *and* a known-good one accepted), and its header records which specific
wordings were found to produce always-NO judges, polarity flips, and a judge that graded on a
curve. Its thresholds were set from measurement and are deliberately strict enough to fail
against the prompt that preceded them.

### The finished report (`src/cli.ts`, `src/reportOutput.ts`)

`report_generator` writes the report to both `final_report` and `messages`, which is right for
a chat UI and wrong for a terminal: it is thousands of words of markdown, and dumping it to
stdout buries the conversation in raw `##` and bracketed URLs that scroll past in one burst.

The CLI therefore **suppresses that one message** — it skips any AI message whose content
contains a non-empty `final_report` — and prints an outline instead: title, `##` sections,
word and source counts, and the saved path. This is a display decision local to `cli.ts`; no
agent or state field changed, so LangGraph Studio and the evals still see the report in
`messages`. If you add a UI, make the same call there rather than changing the graph.

`src/reportOutput.ts` holds the pure part — outline extraction, counts, the filename slug and
the markdown→HTML renderer — with no filesystem or process access, so it is unit-tested
directly in `tests/unit/reportOutput.test.ts` under `npm test`. Two things in it are load-bearing:

- **Every `replace` passes a replacer function**, for the same reason `fillTemplate` exists.
  Report bodies carry Tavily-scraped page text, so a `$'` in a replacement *string* would
  splice surrounding content into the output. Regression tests pin this.
- **`renderHtml` escapes before it substitutes, and accepts only http(s) URLs.** Same untrusted
  source. A rejected URL degrades to its link text rather than becoming a live `javascript:`
  link.

Reports are saved as `reports/<YYYY-MM-DD>-<topic-slug>.md`, slugged from `plan.final_topic`,
falling back to the old bare-timestamp name when there is no plan. A name already taken gets a
`-2`, `-3` suffix rather than overwriting — losing a report that cost a full research run to a
name collision is not a trade worth making for a tidy folder. The date is the local one, not UTC — `toISOString()` names an evening run for tomorrow
anywhere west of Greenwich. `--html` additionally writes a self-contained `.html` sibling and
opens it, which is where the citations become clickable; it is also read from `npm_config_html`,
so the `--` separator `npm run cli -- --html` needs is optional for that one flag.

### Illustrating the report (`src/images/`)

Finished reports carry 1-2 pictures at the end of each section — a battle painting, the weapon
involved, a museum relic, a wartime photograph, or a map of the ground. The source is **Wikimedia Commons only**: it
is the one unauthenticated endpoint that covers all four categories *and* returns the author
and licence fields a credit line needs, and it federates much museum material already (the
Smithsonian's Brown Bess photographs and the Warsaw National Museum's Austerlitz canvas both
arrive this way). Tavily's `includeImages` was evaluated and rejected — it returns images
found on pages matching a *text* query, which means logos and author headshots.

Three modules, split along the testability line the rest of the project uses:

- `commonsImages.ts` — the API client. Network, no LLM.
- `insertImages.ts` — **pure**: decides where a picture lands in the markdown. No network, no
  LLM, so `npm test` covers the placement arithmetic with no API key.
- `illustrate.ts` — the orchestrator, with both the model and the search function injectable.

**It runs inside `report_generator`, after the report text exists** — not in a node of its
own. Two reasons, and both matter if you are tempted to extract it: the pass keys off the
report's *real* `##` headings, which cannot be predicted from `plan` because the report prompt
explicitly lets the model structure sections however it likes; and a new node would have to be
mirrored by hand in `tests/eval/conversationAgent.eval.test.ts`, which nothing guards against
drift. The illustrated text goes to `final_report` **and** `messages`, so Studio and any future
UI get pictures rather than a bare report. No state channel was added — the images live in the
report string.

**Two LLM calls, not one, and the reason is structural**: one call cannot both invent the
search queries and choose among results it has not seen. Call A (`imageQueryPrompt`) reads the
headings plus the research `notes` and emits queries; Call B (`imagePickPrompt`) reads the
fetched candidates and returns picks. Both are `miniModel` and both cover every section at
once, so the picker can avoid giving two sections the same painting. Call A seeing the
**findings** is the point of running after research: a section asking "what was the secret
weapon at X" can only be illustrated once the findings reveal what the weapon was.

Five things here are load-bearing, each measured against the live API rather than assumed:

- **Queries must be 2-4 keywords, never a sentence.** Commons' search is effectively
  conjunctive. `Prokhorovka tank engagement July 1943` returns **0** results;
  `Prokhorovka` returns 3. `British Expeditionary Force ration scales 1914` returns 0;
  `British Expeditionary Force rations` returns 2. `searchWithBackoff` retries with the query
  cut to its proper nouns, and the query prompt's central instruction is to name the thing
  rather than describe it.
- **No model ever supplies a URL.** Call B returns an index into a catalogue the code fetched,
  and every index is re-checked against what that section was actually offered. A model asked
  for a URL produces a plausible one, and a plausible-but-wrong image URL is a broken image in
  a report that cost a full research run.
- **`MIN_IMAGE_LONG_EDGE` is a long edge, not a width.** Over 112 results from 12 queries, a
  long-edge cut at 640 rejects 6 and all six deserve it; `width >= 800` rejects 15, 9 of them
  good images penalised for being tall — including all three Sutton Hoo helmet shots and a
  Bundesarchiv Panzer VI that misses by 12 pixels. A short-edge cut drops 29%. It is also a
  *quality* floor and not a junk filter: `gsrnamespace=6` plus `filetype:bitmap` returned zero
  logos or icons across all 112 results, which is why the cut stays gentle and the picking
  model does the real rejecting.
- **The rate-limit response is plain text, not JSON.** Exceed it and the body is "You are
  making too many requests to the API.", so an unguarded `JSON.parse` throws mid-run. Every
  parse is guarded and requests are spaced by `COMMONS_MIN_INTERVAL_MS`. Measured: 1.2s
  spacing failed on the 11th request of a burst, 2.5s failed once in 13.
- **Use `thumburl`, never `url` — and keep `thumbmime` in `iiprop`.** Originals are
  multi-megabyte (the Gérard Austerlitz canvas is 4000x1983) and may be formats no browser
  renders inline: Commons holds SVG maps and TIFF scans, the Library of Congress Gettysburg
  troop maps among them. The thumbnailer renders both to PNG, so the mime allowlist tests
  `thumbmime` rather than `mime`. **The trap, and it shipped once as a bug:** the API returns
  `thumbmime` *only* if `iiprop` names it. Omit it and the check silently falls back to the
  original's format, rejecting every SVG and TIFF — which kept SVG battle maps out entirely.
  Worse, a unit-test fixture can supply a field the real request never asked for, so the test
  passed while the live code could not do what it claimed. There is now a test asserting the
  **request** contains `thumbmime`; keep it.
- **Maps are first-class, and they crowd out.** `gsrsearch` uses `filetype:bitmap|drawing`
  rather than `bitmap` alone, because many of the best battle maps are SVG; `drawing` was
  measured not to readmit junk ("Brown Bess musket" returns the identical Smithsonian set
  either way). Maps are abundant and rank highly — "Gettysburg battle map" comes back as
  nothing but maps, "Battle of Austerlitz map" as six hourly situation maps — so both prompts
  cap them: at most one map per section, and only for sections about ground, movement or
  position. Note also that Commons holds the same map translated many times, each a separate
  file (`map-alt3 cs.svg`, `Day3heb.png`, `Situation at 1800...-ar.png`), which de-duplication
  by file id cannot merge; the pick prompt rejects language-tagged titles for that reason.

Credits are **unlinked** on purpose: `countSources` counts every `[](...)` in the report, so a
linked credit would inflate the source count with something that is not a source. Author plus
licence in plain text still satisfies CC BY-SA, which the Bundesarchiv photographs genuinely
require. Commons records an absent author as the string "Unknown source" and sometimes doubles
a field by wrapping it in a span, so `metaField` collapses repeats and drops uninformative
values rather than printing "Unknown source Unknown source" under a painting.

`IMAGE_THUMB_WIDTH` is 1600 for the maps' sake: a painting reads fine at 960 scaled into the
`renderHtml` body's ~1152px column (`max-width: 75rem` less the 1.5rem gutters), but a
4950x5917 Gettysburg day map squeezed to 1152px has illegible troop labels. The widened body
left 1600 with *less* headroom than it had, not more — it is now only ~1.4x the column, and
below 2x on a retina display — so lowering it back toward 960 would now be visible. It is an
upper *request*, not a guarantee — Commons rounds to its own thumbnail buckets (asking 1600 was
observed to return 1920) and serves the original untouched when it is already smaller. The same
widening means `MIN_IMAGE_LONG_EDGE` no longer implies a column-filling image: at 640 a picture
now renders at a bit over half the column, since `max-width: 100%` scales down and never up.

Images are hotlinked rather than downloaded. That is a deliberate first step and it is the one
decision here in tension with `renderHtml`'s promise that the HTML "still reads offline" — if
that promise starts mattering, the shape to reach for is markdown keeping the remote URL while
`--html` inlines the bytes as `data:` URIs.

**Everything about this pass is best-effort and cannot fail a run.** No illustratable section,
no queries produced, a Commons outage, a malformed model response, an unreachable image: every
path returns the unillustrated report. `illustrateReport` catches internally and
`report_generator` catches again around the call, because that node is the last place a
finished report can be lost.

### Tavily search pipeline (`src/tools/tavilySearch.ts`)

`executeTavilySearch` dedupes results by URL, then summarizes each page's raw content via `miniModel` (falling back to a 1000-char truncation on any failure — model error or unparsable JSON), then formats everything into a numbered `SOURCE` block string that becomes the `ToolMessage` content the researcher LLM reads next.

### Tracing harnesses (`src/trace/`)

`traceResearcher.ts` and `traceSupervisor.ts` run one agent and write everything that happened
to a gitignored folder under `traces/`. They are analysis tools, not pipeline code — nothing in
`src/` outside `src/trace/` imports them, and they are deliberately *not* instrumentation: an
instrumented agent is not the agent you want to measure, so both harnesses observe from outside
and no agent file knows they exist.

```bash
npm run trace:researcher -- "a research topic"
npm run trace:supervisor -- --topic "..." --angle "..." --angle "..."
npm run trace:supervisor -- --markers   # print the call-attribution markers and exit; no API calls
npm run trace:supervisor -- --judge     # also spend one miniModel call mapping dispatches to angles
```

Both default to a real plan from the 2026-09-29 run recorded in `cli.log`, so a trace reflects
work the pipeline actually produced rather than a topic invented for the harness. Each run
writes `summary.md` (the report to read first), `transcript.md` (every message verbatim),
`updates.jsonl`, a `state-NN-<node>.json` per superstep, and `calls.json`.

Two mechanisms, both in `traceCommon.ts`:

- **`streamMode: ["updates", "values"]`** exposes the state machine: "updates" is the delta each
  node returned, "values" the full state after it. Note the delta is the node's *return value* —
  `supervisor_tool_node` returns plain `{role: "tool"}` dicts rather than `ToolMessage`s, which
  LangGraph coerces on the way into state but the stream does not, so `encodeMessage` tolerates
  both. Assuming `getType()` crashes the supervisor trace at its first tool node.
- **Wrapping `invoke` on the model singletons.** Agents look `invoke` up on the module-scope
  tiers at call time, so wrapping it records every call's tokens without touching an agent. This
  is the only way to see the per-page `miniModel` summarisation calls inside `executeTavilySearch`,
  which never enter any messages channel. `bindTools()` needs its own wrapper: `ChatOpenAI`
  returns a *fresh clone* rather than a binding that delegates, so a dispatch model bound at an
  agent's module scope is invisible otherwise — which is why both harnesses patch before the
  dynamic `import()` of any agent.

`trace:supervisor` costs real money on a scale the other scripts do not: the supervisor spawns
researchers for real (`MAX_SUPERVISOR_TURNS + 1` turns × up to `MAX_CONCURRENT_RESEARCH_UNITS`
researchers, each its own multi-turn loop with Tavily searches). It does not patch `researchAgent`
— it reports what the supervisor itself sees, the dispatched topic going in and the
`compressed_research` coming back — but every researcher's LLM calls still land in the same
patched singletons. Each call is therefore attributed to its caller by matching the prompt it sent
against markers *derived from the prompt modules at runtime*, never hand-copied, so rewording a
prompt cannot silently turn the classifier into one that answers "unknown" for everything. That
attribution is what produces the supervisor-spend-versus-researcher-spend split in `summary.md`.

`summary.md` from `trace:supervisor` also answers the open question in `src/plan.ts`: whether the
supervisor researched the angles the user approved, or derived its own sub-topics from the brief.
Each angle is printed against its best-matching dispatched topic, with a word-overlap figure that
is a hint for where to look rather than a verdict — unrelated angles of one battle share its
proper nouns, so the overlap floor is well above zero (see `WEAK_OVERLAP`).
