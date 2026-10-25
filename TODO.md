# TODO

Living backlog of action items for the War Research project. Add items here as they come up; check them off (or delete) once done. See `CLAUDE.md` for architecture context.

## Open

- [ ] **Angles are too narrow**

- [ ] **Output quality: prose over bullet lists.** Final reports currently read as large bullet lists; expectation is a few paragraphs / short-article style. `reportGeneratorPrompt` (`src/prompts/reportGeneratorPrompt.ts`) already says "write in paragraph form" but the report is likely inheriting bullet-heavy style from the researcher's `compressed_research` notes feeding into it — needs investigation into both `researcherCompressionPrompt.ts` and `reportGeneratorPrompt.ts`.

- [ ] **Optimize CLI output**

- [ ] Replace `MemorySaver` with a persistent checkpointer (see task list / `src/conversationAgent.ts`).

- [ ] **Go public: front end + backend API + AWS deployment.** 


### Correctness and cost

- [ ] **Migrate `fullModel` and `miniModel` off the gpt-4.1 family before 2027-01-14.** OpenAI retires `gpt-4.1` and `gpt-4.1-mini` on that date; `gpt-4.1-nano` was already shut down on 2026-10-23 and took the whole dispatch half of the pipeline down with it (404 `MODEL_NOT_FOUND`), which is why `nanoModel` now points at `gpt-5.4-nano`. Do not assume the replacement the deprecation notice names is usable: it recommends the `*-luna` line, and `gpt-5.6-luna`/`gpt-6-luna` both reject function tools on `/v1/chat/completions` ("Function tools with reasoning_effort are not supported") *and* reject `temperature: 0` ("Only the default (1) value is supported"), so neither can serve a tier of this project as written. `gpt-5.4` and `gpt-5.4-mini` were verified to accept both temperature 0 and forced tool calling through `ChatOpenAI` + `bindTools`, so they are the low-risk target; the alternative is moving to the Responses API and dropping the temperature-0 assumption. Note this is not a pure find-and-replace: `fullModel` is the assess tier and `miniModel` backs `classify_feedback`, `summarizeWebpage` and both illustration calls, so the angle judges in `tests/eval/angleJudges.ts` are calibrated against current behaviour and need re-checking after the swap (see that file's header). Update `PRICES` in `src/trace/traceCommon.ts` and the model IDs in `CLAUDE.md` in the same commit.
- [ ] **Enforce `MAX_CONCURRENT_RESEARCH_UNITS`.** `supervisorAgent.ts:101-111` passes every `ConductResearch` tool call to `Promise.all` with no cap — the limit exists only as text in the dispatch prompt, and `nanoModel` decides how many calls to emit. The researcher already enforces its equivalent with `searchCalls.slice(0, MAX_CONCURRENT_TAVILY_SEARCHES)` (`researchAgent.ts:100`); mirror that. Largest uncontrolled cost multiplier in the system, since each spawned researcher is its own multi-turn loop.
- [ ] **Isolate researcher failures.** The same `Promise.all` (`supervisorAgent.ts:103`) fails the whole run if one researcher rejects, discarding all sibling work. `Promise.allSettled` would let partial results through. Note the researcher's Tavily path is already defensive by contrast (`tavilySearch.ts:95` catches and returns an error string).
- [ ] **Decide what to do about `raw_notes` — currently dead state.** Declared with custom merge reducers in all three state schemas, written once at `researchAgent.ts:150`, never read. The supervisor only reads `compressed_research` off each researcher result (`supervisorAgent.ts:115`), so raw notes never reach `ConversationState`. Either delete it or wire it through. Note this no longer blocks anything: the images feature was expected to need it as a carrier for image refs, but the illustration pass runs in `report_generator` off the finished report and the `notes`, so it added no state channel at all. Deleting `raw_notes` is now the cheaper of the two options unless something else wants it.
- [ ] **Reconcile iteration-limit off-by-one.** Supervisor checks `research_iterations > MAX_SUPERVISOR_TURNS` after incrementing (`supervisorAgent.ts:81`); researcher checks `>= MAX_RESEARCHER_TURNS` before (`researchAgent.ts:44`). Both constants are 5, but the supervisor gets 6 turns and the researcher 5 — the config numbers don't mean the same thing.

### Tests

- [ ] **Add unit tests for `supervisorAgent.ts`** — currently zero coverage on the orchestration layer holding the trickiest logic (completion detection, iteration limits, note extraction, parallel spawning). Follow the `vi.mock`/`vi.hoisted` pattern from `tests/unit/researchAgent.test.ts`.
- [ ] **Add *unit* tests for the remaining pre-research nodes and `report_generator`.** `propose_plan` is now covered by `tests/unit/conversationAgent.test.ts` (angle ceiling, shorter plans passing through, both routes out). `report_generator` is now covered too (illustrated text reaching both `final_report` and `messages`, and the guard that keeps a report when the illustration pass throws). Still missing: `scope_topic` (three statuses + `MAX_CLARIFY_ROUNDS` give-up), `classify_feedback` (approve / angle / topic routing and counter resets), `dispatch_research`. All take an injected model, so they're cheap to cover. `tests/eval/conversationAgent.eval.test.ts` now covers this layer end-to-end against real LLMs — including the explicit-hold and bare-specific-topic cases — but it costs money per run, so the cheap mocked path is still missing.
- [ ] **Guard the eval's mirrored graph against drift.** `tests/eval/conversationAgent.eval.test.ts` hand-assembles a copy of `conversationGraph` (same nodes, same model tiers, but `dispatch_research` routes to `END` so no researchers spawn). Nothing checks that the two still agree, and the file's own header says as much: rename or re-route a node in `src/conversationAgent.ts` and the eval keeps passing while testing wiring that no longer exists. Cheapest fix is a unit test comparing the two graphs' node and edge sets — no API calls needed.
- [ ] **Typecheck the tests.** `tsconfig.json` has `include: ["src/**/*"]`, so `npm run build` never sees `tests/`; type errors there surface only if vitest happens to execute that line.

### Hygiene

- [x] **Add a README** — `README.md` covers what the project does and does not do, the `.env` keys and first run, the CLI walkthrough and flags, a simplified mermaid graph (the annotated one stays in `docs/question-flow.md`), Studio and the trace harnesses, and the layout. Note `reports/` is gitignored, so it quotes a run rather than linking a sample report; commit one if a linked example is wanted.
- [x] **Add CI** — tests pass and cost nothing (`tests/unit` is fully mocked), but nothing runs them automatically. Keep `tests/eval` out of CI; it makes real paid API calls.
- [x] **Add `engines` / `.nvmrc`** — `langgraph.json` pins `node_version: "20"` but `package.json` declares nothing.
- [ ] **Drop `ANTHROPIC_API_KEY` from the local `.env` / `.env.example`** (or start using it) — every model currently routes through `ChatOpenAI` in `src/model.ts`. Both files are gitignored, so this is local hygiene plus the key list in `CLAUDE.md`.
- [ ] **Add a linter/formatter** — none configured.
- [x] **Add a LICENSE** — MIT, matching the dependency stack (LangChain/LangGraph, Tavily SDK and zod are all MIT). `package.json` declares `"license": "MIT"` to match. The README notes that it covers the code only: report text is model-synthesised from third-party sources and the images are hotlinked from Wikimedia Commons under their own licences, some CC BY-SA.
