# TODO

Living backlog of action items for the War Research project. Add items here as they come up; check them off (or delete) once done. See `CLAUDE.md` for architecture context.

## Open

- [ ] **Collaborative scoping: shape the `research_brief` with the user.** Today `clarification_node` is effectively a classifier — reject / ask at most one question / pass — and `briefing_node` then derives `research_brief` silently, so the user never sees what will actually be researched. Goal: a short guided dialogue (a few related questions) that helps the user discover what they actually want to know, with the brief as the shared output.

  Agreed design decisions:
  - **Questions must come with options.** "What aspect of WWII interests you?" hands the problem back to a user who doesn't know. Offer a menu ("Eastern Front / Pacific theater / home front / codebreaking") — supplying the options *is* the value.
  - **Cap the turns explicitly.** Add a `MAX_SCOPING_TURNS` (~2–3) to `src/config.ts`, matching the existing `MAX_SUPERVISOR_TURNS` / `MAX_RESEARCHER_TURNS` budget idiom.
  - **Always leave an exit.** "Just research it" / "you pick" short-circuits straight to the brief, so expert users who already know what they want aren't forced through an interview.
  - **Show the brief at the end.** Surface the final brief for confirmation before the expensive research phase starts. Without this the user hasn't co-shaped anything — they answered questions and hoped.

  Likely mechanism: LangGraph's `interrupt()` (confirmed available in the installed `@langchain/langgraph` 1.3.7) instead of the current end-the-graph-and-resume-from-START approach. `interrupt()` pauses mid-node and resumes via `Command({ resume })`, so scoping state can live in explicit state fields rather than being re-inferred from message history every turn — which is why `clarificationPrompt.ts` currently needs its "if you already asked, don't ask again" guards. The existing checkpointer (`conversationAgent.ts:126`) is the prerequisite and is already in place; LangGraph Studio has first-class interrupt/resume UI.

  Open questions (defer to implementation discussion):
  - Split the cheap reject gate and the scoping dialogue into separate nodes, or keep them in one? (Current `clarificationPrompt.ts` is 78 lines doing three jobs: relevance, ambiguity, focus.)
  - When the question is already specific ("what were the turning points at Stalingrad?"), should scoping ask anything at all, or pass straight through as it does today?

  Note: this does **not** fix the bullet-list problem — shaping the brief shapes *what* is researched, not how the report is structured. Tracked separately below.

- [ ] **Output quality: prose over bullet lists.** Final reports currently read as large bullet lists; expectation is a few paragraphs / short-article style. `reportGeneratorPrompt` (`src/prompts/reportGeneratorPrompt.ts`) already says "write in paragraph form" but the report is likely inheriting bullet-heavy style from the researcher's `compressed_research` notes feeding into it — needs investigation into both `researcherCompressionPrompt.ts` and `reportGeneratorPrompt.ts`.
- [ ] **Output should include images.** No image capability exists anywhere in the pipeline today — Tavily search is text-only (`src/tools/tavilySearch.ts`), and no prompt references embedding images. Needs a design decision: image search API (Tavily supports `includeImages`), how images get carried through `raw_notes`/`notes` state, and how the final report embeds them (markdown `![]()` with source URLs vs. downloading/storing).
- [ ] Replace `MemorySaver` with a persistent checkpointer (see task list / `src/conversationAgent.ts:122`).

- [ ] **Go public: front end + backend API + AWS deployment.** Large multi-part effort, not yet scoped — details to be discussed later. Rough shape: a web front end, a backend server exposing the graph over HTTP, and deployment of both to AWS.

  Known dependencies / things that will need answers when we plan it (recorded for tracking only, not decided):
  - Blocked by the persistent-checkpointer item above — `MemorySaver` is per-process and in-memory, so it cannot back a multi-instance or serverless deployment. The TODO at `src/conversationAgent.ts:122` is precisely this blocker.
  - The collaborative-scoping item implies the API needs a resume surface, not just a single request/response call — `interrupt()` pauses a run and expects a later resume against the same thread.
  - Secrets: API keys currently come from a local `.env` via `dotenv` and will need real secrets management.
  - Public exposure means unbounded LLM spend — will need auth and/or rate limiting, and runs are long (minutes), which constrains the request model (streaming/polling rather than a blocking HTTP call).

## Secondary tasks

Smaller gaps found in a codebase scan (2026-09-13). Not blocking feature work, but several de-risk the "go public" item above. Baseline at time of scan: `npx tsc --noEmit` clean, 26 unit tests passing.

### Correctness and cost

- [ ] **Enforce `MAX_CONCURRENT_RESEARCH_UNITS`.** `supervisorAgent.ts:101-111` passes every `ConductResearch` tool call to `Promise.all` with no cap — the limit exists only as text in the dispatch prompt, and `nanoModel` decides how many calls to emit. The researcher already enforces its equivalent with `searchCalls.slice(0, MAX_CONCURRENT_TAVILY_SEARCHES)` (`researchAgent.ts:100`); mirror that. Largest uncontrolled cost multiplier in the system, since each spawned researcher is its own multi-turn loop.
- [ ] **Isolate researcher failures.** The same `Promise.all` (`supervisorAgent.ts:103`) fails the whole run if one researcher rejects, discarding all sibling work. `Promise.allSettled` would let partial results through. Note the researcher's Tavily path is already defensive by contrast (`tavilySearch.ts:95` catches and returns an error string).
- [ ] **Decide what to do about `raw_notes` — currently dead state.** Declared with custom merge reducers in all three state schemas, written once at `researchAgent.ts:150`, never read. The supervisor only reads `compressed_research` off each researcher result (`supervisorAgent.ts:105`), so raw notes never reach `ConversationState`. Either delete it or wire it through — it's the natural carrier for source URLs and image refs, so decide this **before** starting the images item.
- [ ] **Reconcile iteration-limit off-by-one.** Supervisor checks `research_iterations > MAX_SUPERVISOR_TURNS` after incrementing (`supervisorAgent.ts:81`); researcher checks `>= MAX_RESEARCHER_TURNS` before (`researchAgent.ts:44`). Both constants are 5, but the supervisor gets 6 turns and the researcher 5 — the config numbers don't mean the same thing.

### Tests

- [ ] **Add unit tests for `supervisorAgent.ts`** — currently zero coverage on the orchestration layer holding the trickiest logic (completion detection, iteration limits, note extraction, parallel spawning). Follow the `vi.mock`/`vi.hoisted` pattern from `tests/unit/researchAgent.test.ts`.
- [ ] **Add tests for `briefing_node` and `report_generator`** — both already take an injected model, so they're cheap to cover.
- [ ] **Typecheck the tests.** `tsconfig.json` has `include: ["src/**/*"]`, so `npm run build` never sees `tests/`; type errors there surface only if vitest happens to execute that line.

### Hygiene

- [ ] **Add a README** — nothing currently tells a human what this project is or how to run it. Becomes a real gap when the project goes public.
- [ ] **Add CI** — tests pass and cost nothing (`tests/unit` is fully mocked), but nothing runs them automatically. Keep `tests/eval` out of CI; it makes real paid API calls.
- [ ] **Remove `console.log` from the production path** (`tavilySearch.ts:110-116`) or put it behind a verbosity flag — fine in Studio, noise in a deployed server.
- [ ] **Delete `plan.md`** — stale (still "TBD" for architecture that's been built), and gitignored anyway. `CLAUDE.md` and this file now cover its job.
- [ ] **Add `engines` / `.nvmrc`** — `langgraph.json` pins `node_version: "20"` but `package.json` declares nothing.
- [ ] **Drop `ANTHROPIC_API_KEY` from `.env.example`** (or start using it) — every model currently routes through `ChatOpenAI` in `src/model.ts`.
- [ ] **Add a linter/formatter** — none configured.
- [ ] **Add a LICENSE** if "open to public" means open source.

## Done

(none yet)
