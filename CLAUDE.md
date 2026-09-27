# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # tsc compile to dist/
npm run dev                # npx @langchain/langgraph-cli dev — starts LangGraph Studio dev server
npm test                   # vitest run tests/unit (mocked, no API calls)
npm run llm-test           # vitest run tests/eval (real OpenAI + Tavily calls, LLM-as-judge assertions)
npm run llm-test:conversation  # just the pre-research eval — no researchers spawned, so far cheaper than the rest of tests/eval

# Single test file
npx vitest run tests/unit/researchAgent.test.ts
npx vitest run tests/eval/researchAgent.eval.test.ts

# Single test case
npx vitest run tests/unit/researchAgent.test.ts -t "test name substring"
```

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
2. **Dispatch** (`nanoModel`, gpt-4.1-nano, `tool_choice: "required"`) — forced to emit a tool call based on the assessment, decoupling "thinking" from "acting" so the cheap model only has to pick a tool, not reason.

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

### Tavily search pipeline (`src/tools/tavilySearch.ts`)

`executeTavilySearch` dedupes results by URL, then summarizes each page's raw content via `miniModel` (falling back to a 1000-char truncation on any failure — model error or unparsable JSON), then formats everything into a numbered `SOURCE` block string that becomes the `ToolMessage` content the researcher LLM reads next.
