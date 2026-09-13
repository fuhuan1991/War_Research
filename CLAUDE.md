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

Requires `.env` (see `.env.example`): `OPENAI_API_KEY` and `TAVILY_API_KEY` are required; `ANTHROPIC_API_KEY` is declared but unused (all models currently route through `ChatOpenAI` — see `src/model.ts`); `LANGSMITH_*` is optional tracing.

`tests/eval/*` make real LLM and Tavily calls and cost money/time — only run when explicitly needed, not as part of routine iteration.

## Architecture

This is a war-focused deep research agent (LangGraph.js), structured as three nested graphs that mirror a lead-researcher/sub-researcher pattern:

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

`langgraph.json` registers all three graphs independently so each can be run/visualized on its own in LangGraph Studio, not just as a whole. `docs/question-flow.md` has the full annotated flow diagram (mermaid) including which model tier and message role each node uses — check it before changing routing logic.

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

Synthetic control-flow `ToolMessage`s (e.g. `"<Research completed>"`) are wrapped in angle brackets by convention; `compression_node` filters these out via `.startsWith("<")` when extracting real `raw_notes`, so preserve that convention if you add new synthetic messages.

### Dependency injection for testing

`conversationAgent.ts` node factories (`makeClarificationNode(llm)`, `makeBriefingNode(llm)`, `makeReportGenerator(llm)`) take the model as a parameter so tests can inject a fake. `supervisorAgent.ts`/`researchAgent.ts` node factories instead import `fullModel`/`nanoModel` from `src/model.ts` directly at module scope; unit tests mock that whole module with `vi.mock("../../src/model.js", ...)` plus `vi.hoisted` (see `tests/unit/researchAgent.test.ts`) rather than injecting.

### Tavily search pipeline (`src/tools/tavilySearch.ts`)

`executeTavilySearch` dedupes results by URL, then summarizes each page's raw content via `miniModel` (falling back to a 1000-char truncation on any failure — model error or unparsable JSON), then formats everything into a numbered `SOURCE` block string that becomes the `ToolMessage` content the researcher LLM reads next.
