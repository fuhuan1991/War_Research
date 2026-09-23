# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # tsc compile to dist/
npm run dev                # npx @langchain/langgraph-cli dev — starts LangGraph Studio dev server
npm test                   # vitest run tests/unit (mocked, no API calls)
npm run llm-test           # vitest run tests/eval (real OpenAI + Tavily calls, LLM-as-judge assertions)

# Single test file
npx vitest run tests/unit/researchAgent.test.ts
npx vitest run tests/eval/clarification_prompt.eval.test.ts

# Single test case
npx vitest run tests/unit/researchAgent.test.ts -t "test name substring"
```

Requires a `.env` in the project root. There is no `.env.example` in the repo — it is gitignored — so the keys are listed here instead:

```bash
OPENAI_API_KEY=       # required — every model routes through ChatOpenAI (src/model.ts)
TAVILY_API_KEY=       # required — web search (src/tools/tavilySearch.ts)
ANTHROPIC_API_KEY=    # unused today; no model routes through Anthropic
LANGSMITH_API_KEY=    # optional — tracing
LANGSMITH_TRACING=
LANGSMITH_PROJECT=war-research
```

`tests/eval/*` make real LLM and Tavily calls and cost money/time — only run when explicitly needed, not as part of routine iteration.

## Project docs

- `TODO.md` — the authoritative backlog. **Read it before proposing work.** It already tracks the known gaps (unenforced `MAX_CONCURRENT_RESEARCH_UNITS`, `Promise.all` failure isolation, dead `raw_notes`, iteration-limit off-by-one, missing README/CI/linter), so they don't need re-deriving from a fresh scan.
- `docs/question-flow.md` — annotated mermaid flow of the main pipeline, including which model tier and message role each node uses. Check it before changing routing logic. It predates `conversationAgentB` and does not cover it.
- `conversation_plan.md` — node-level design doc for the scoping / plan-confirmation loop that `src/conversationAgentB.ts` implements.
- `plan.md` — stale original build plan, gitignored. Superseded by this file and `TODO.md`; ignore it.

## Architecture

This is a war-focused deep research agent (LangGraph.js). The main pipeline is three nested graphs that mirror a lead-researcher/sub-researcher pattern (a fourth, experimental top-level graph is described under `conversationAgentB` below):

```
conversationGraph (src/conversationAgent.ts)   — top-level graph, holds the checkpointer
  clarification_node → briefing_node → supervisor_agent (subgraph) → report_generator
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

`langgraph.json` registers all four graphs — the three above plus `conversationAgentB` — independently, so each can be run and visualized on its own in LangGraph Studio, not just as a whole.

### The assess → dispatch pattern

Both `supervisorAgent` and `researchAgent` split each turn into two LLM calls instead of one:
1. **Assess** (`fullModel`, gpt-4.1) — reasons over state in prose, appended as an `AIMessage`.
2. **Dispatch** (`nanoModel`, gpt-4.1-nano, `tool_choice: "required"`) — forced to emit a tool call based on the assessment, decoupling "thinking" from "acting" so the cheap model only has to pick a tool, not reason.

`miniModel` (gpt-4.1-mini) is reserved for cheaper structured-output work: `briefing_node` and per-page `summarizeWebpage`.

### Routing via `Command`, not conditional edges

Every node that needs to branch returns `new Command({ goto, update })` rather than relying on `addConditionalEdges`. Graph builders declare the possible destinations via `{ ends: [...] }` on `addNode` for LangGraph Studio's benefit, but the actual branching logic lives inside the node function.

### Tools are never executed by the LLM-facing tool object

`ConductResearch`/`CompleteResearch` (supervisor) and `TavilySearch`/`CompleteSearch` (researcher) are defined with `tool()` purely so their schema can be bound to the dispatching model — their `func` bodies are stubs. The real side effects (spawning a sub-agent, calling Tavily) happen in the paired `*_tool_node` function, which reads `tool_calls` off the last `AIMessage` and constructs `ToolMessage`s manually. When adding a new tool, follow this split rather than putting logic in the `tool()` call itself.

### State shape

States are zod schemas wrapped in `withLangGraph` (`src/states/*.ts`):
- Message fields (`messages`, `supervisor_messages`, `researcher_messages`) use `MessagesZodMeta` for LangGraph's built-in message-append reducer.
- `notes`/`raw_notes` use a custom `(a, b) => [...a, ...b]` reducer so parallel branches (parallel researchers, parallel searches) merge without clobbering each other.
- `research_iterations` is a plain counter checked against `MAX_SUPERVISOR_TURNS`/`MAX_RESEARCHER_TURNS` (`src/config.ts`) to force termination.
- Non-message fields that a node reads back must declare their default via `withLangGraph(..., { default })`, not zod's `.default()`. LangGraph builds its channels from the registry metadata, so a plain `z.number().default(0)` reads back as `undefined` inside a node and `state.counter + 1` silently becomes `NaN` (see `src/states/conversationStateB.ts`).

Synthetic control-flow `ToolMessage`s (e.g. `"<Research completed>"`) are wrapped in angle brackets by convention; `compression_node` filters these out via `.startsWith("<")` when extracting real `raw_notes`, so preserve that convention if you add new synthetic messages.

### `conversationAgentB` — experimental scoping graph (human-in-the-loop)

`src/conversationAgentB.ts` is a **second, parallel top-level graph, not a replacement** for `conversationAgent.ts`. Both are registered and both run. It swaps the one-shot `clarification_node` for a negotiation loop: scope the topic, propose a plan (final topic + 3–5 angles), and get explicit user approval before any research starts.

```
START → scope_topic ⇄ ask_user          (nudge the user until the topic is workable)
              │
              ▼
        propose_plan → confirm_plan → research → END
              ▲             │
              └─ classify_feedback ─┘   (angle-level feedback replans; topic-level restarts scoping)
```

- State is `ConversationStateB` (`src/states/conversationStateB.ts`), which **extends** `ConversationState` — so it inherits `research_brief`/`supervisor_messages`/`final_report`, which graph B does not currently use.
- `research` is a **placeholder** node: it reports what it would have researched and calls no sub-agent. Graph B is therefore not yet a superset of graph A.
- `MAX_CLARIFY_ROUNDS`/`MAX_CONFIRM_ROUNDS` are deliberately local to the file rather than in `src/config.ts`, to keep the experiment's footprint inside its own files. Promote them if it graduates.
- Design doc: `conversation_plan.md`.

**The `interrupt()` rule.** Graph B pauses for the user with LangGraph's `interrupt()`, which requires a checkpointer. A node that calls `interrupt()` **re-executes from the top on resume**, so:

- Never mix an LLM call and an `interrupt()` in one node. `ask_user` and `confirm_plan` are interrupt-only; `scope_topic`, `propose_plan` and `classify_feedback` are LLM-only. Preserve that split when adding nodes — a mixed node would re-fire its LLM call on every resume.
- Anything an interrupting node needs on resume must live in state, never in a local variable. This is why `propose_plan` writes `plan` to state *before* `confirm_plan` pauses: `confirm_plan` rebuilds its interrupt payload from state each time it re-executes.
- Resume contract for `confirm_plan`: `new Command({ resume: { approved: true } })` to approve, or `new Command({ resume: { feedback: "..." } })` to reject. Anything else is treated as feedback.

### Dependency injection for testing

`conversationAgent.ts` node factories (`makeClarificationNode(llm)`, `makeBriefingNode(llm)`, `makeReportGenerator(llm)`) take the model as a parameter so tests can inject a fake. `supervisorAgent.ts`/`researchAgent.ts` node factories instead import `fullModel`/`nanoModel` from `src/model.ts` directly at module scope; unit tests mock that whole module with `vi.mock("../../src/model.js", ...)` plus `vi.hoisted` (see `tests/unit/researchAgent.test.ts`) rather than injecting. `conversationAgentB.ts` follows the injecting style (`makeScopeTopicNode(llm)`, `makeProposePlanNode(llm)`, `makeClassifyFeedbackNode(llm)`).

### Tavily search pipeline (`src/tools/tavilySearch.ts`)

`executeTavilySearch` dedupes results by URL, then summarizes each page's raw content via `miniModel` (falling back to a 1000-char truncation on any failure — model error or unparsable JSON), then formats everything into a numbered `SOURCE` block string that becomes the `ToolMessage` content the researcher LLM reads next.
