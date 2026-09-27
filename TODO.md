# TODO

Living backlog of action items for the War Research project. Add items here as they come up; check them off (or delete) once done. See `CLAUDE.md` for architecture context.

## Open

- [ ] **Output quality: prose over bullet lists.** Final reports currently read as large bullet lists; expectation is a few paragraphs / short-article style. `reportGeneratorPrompt` (`src/prompts/reportGeneratorPrompt.ts`) already says "write in paragraph form" but the report is likely inheriting bullet-heavy style from the researcher's `compressed_research` notes feeding into it — needs investigation into both `researcherCompressionPrompt.ts` and `reportGeneratorPrompt.ts`.
- [ ] **Output should include images.** No image capability exists anywhere in the pipeline today — Tavily search is text-only (`src/tools/tavilySearch.ts`), and no prompt references embedding images. Needs a design decision: image search API (Tavily supports `includeImages`), how images get carried through `raw_notes`/`notes` state, and how the final report embeds them (markdown `![]()` with source URLs vs. downloading/storing).
- [ ] **Make the supervisor research the angles the user approved.** `dispatch_research` (`src/conversationAgent.ts`) hands the supervisor the confirmed plan as prose via `planToBrief()`, but `supervisor_node` still derives its own sub-topics from it — so the angles the user saw and approved are a suggestion, not a guarantee. Fix: have the supervisor emit one `ConductResearch` call per angle on its first turn, skipping that turn's LLM dispatch entirely, then let the normal assess → dispatch loop take over for gap-filling. `ANGLES_PER_PLAN` is already pinned to 3 to match `MAX_CONCURRENT_RESEARCH_UNITS`.

- [ ] **Make the proposed angles MECE (mutually exclusive, collectively exhaustive).** The angles `propose_plan` produces (`makeProposePlanNode`, `src/conversationAgent.ts:156`) overlap in practice and leave gaps — two angles pull the same sources (two researchers duplicate work, and the report says the same thing twice) while whole dimensions of the topic go unresearched. Today the only pressure toward MECE is prose in `proposePlanPrompt` ("Angles must not overlap", "together they should cover the topic"): the prompt states the goal but gives no rule for *how* to cut the topic, and nothing checks the result. With `ANGLES_PER_PLAN = 3`, one overlapping pair burns a third of the research budget, so this is a cost item as much as a quality one.

  Options to weigh when this gets picked up (none decided):
  - Force a single partition axis instead of leaving it implicit — phases in time, levels of war (strategic / operational / tactical), or actors — since mixing axes in one breakdown is the classic way a decomposition stops being MECE. The prompt's current "warfare-specific lenses" list actively invites axis-mixing.
  - Widen `ProposePlanOutput` (`src/conversationAgent.ts:37`) so each angle carries a one-line scope note (what it covers / what it explicitly leaves to the other angles), plus a plan-level "deliberately out of scope" line. Makes gaps visible to the user at `confirm_plan` time instead of only in the final report.
  - Add a cheap `miniModel` critique pass over the angle set (overlap + coverage check, one revision at most) before the plan reaches the user — same tier already used by `classify_feedback`.
  - Whichever route: cover it in the `propose_plan` unit tests listed under Tests below, and note that an eval (LLM-as-judge on overlap/coverage) is the only way to really measure it.

  Related: **Make the supervisor research the angles the user approved** above — MECE angles only pay off if the supervisor dispatches them one-to-one rather than re-deriving its own sub-topics.

- [ ] Replace `MemorySaver` with a persistent checkpointer (see task list / `src/conversationAgent.ts`).

- [ ] **Go public: front end + backend API + AWS deployment.** Large multi-part effort, not yet scoped — details to be discussed later. Rough shape: a web front end, a backend server exposing the graph over HTTP, and deployment of both to AWS.

  Known dependencies / things that will need answers when we plan it (recorded for tracking only, not decided):
  - Blocked by the persistent-checkpointer item above — `MemorySaver` is per-process and in-memory, so it cannot back a multi-instance or serverless deployment. The `MemorySaver` TODO in `src/conversationAgent.ts` is precisely this blocker.
  - The graph now pauses at `ask_user` and `confirm_plan`, so the API needs a resume surface, not just a single request/response call — `interrupt()` pauses a run and expects a later resume against the same `thread_id` via `new Command({ resume })`. This is no longer hypothetical; it is the live calling contract.
  - Secrets: API keys currently come from a local `.env` via `dotenv` and will need real secrets management.
  - Public exposure means unbounded LLM spend — will need auth and/or rate limiting, and runs are long (minutes), which constrains the request model (streaming/polling rather than a blocking HTTP call).

## Secondary tasks

Smaller gaps found in a codebase scan (2026-09-13); line references re-verified against the code on 2026-09-26. Not blocking feature work, but several de-risk the "go public" item above. Baseline at that re-check: `npx tsc --noEmit` clean, 23 unit tests passing across 2 files.

### Correctness and cost

- [ ] **Enforce `MAX_CONCURRENT_RESEARCH_UNITS`.** `supervisorAgent.ts:101-111` passes every `ConductResearch` tool call to `Promise.all` with no cap — the limit exists only as text in the dispatch prompt, and `nanoModel` decides how many calls to emit. The researcher already enforces its equivalent with `searchCalls.slice(0, MAX_CONCURRENT_TAVILY_SEARCHES)` (`researchAgent.ts:100`); mirror that. Largest uncontrolled cost multiplier in the system, since each spawned researcher is its own multi-turn loop.
- [ ] **Isolate researcher failures.** The same `Promise.all` (`supervisorAgent.ts:103`) fails the whole run if one researcher rejects, discarding all sibling work. `Promise.allSettled` would let partial results through. Note the researcher's Tavily path is already defensive by contrast (`tavilySearch.ts:95` catches and returns an error string).
- [ ] **Decide what to do about `raw_notes` — currently dead state.** Declared with custom merge reducers in all three state schemas, written once at `researchAgent.ts:150`, never read. The supervisor only reads `compressed_research` off each researcher result (`supervisorAgent.ts:115`), so raw notes never reach `ConversationState`. Either delete it or wire it through — it's the natural carrier for source URLs and image refs, so decide this **before** starting the images item.
- [ ] **Reconcile iteration-limit off-by-one.** Supervisor checks `research_iterations > MAX_SUPERVISOR_TURNS` after incrementing (`supervisorAgent.ts:81`); researcher checks `>= MAX_RESEARCHER_TURNS` before (`researchAgent.ts:44`). Both constants are 5, but the supervisor gets 6 turns and the researcher 5 — the config numbers don't mean the same thing.

### Tests

- [ ] **Add unit tests for `supervisorAgent.ts`** — currently zero coverage on the orchestration layer holding the trickiest logic (completion detection, iteration limits, note extraction, parallel spawning). Follow the `vi.mock`/`vi.hoisted` pattern from `tests/unit/researchAgent.test.ts`.
- [ ] **Add *unit* tests for the pre-research nodes and `report_generator`.** `scope_topic` (three statuses + `MAX_CLARIFY_ROUNDS` give-up), `propose_plan` (`MAX_CONFIRM_ROUNDS` auto-accept, angle truncation to `ANGLES_PER_PLAN`), `classify_feedback` (approve / angle / topic routing and counter resets), `dispatch_research`, `report_generator`. All take an injected model, so they're cheap to cover. `tests/eval/conversationAgent.eval.test.ts` now covers this layer end-to-end against real LLMs — including the explicit-hold and bare-specific-topic cases — but it costs money per run, so the cheap mocked path is still missing.
- [ ] **Guard the eval's mirrored graph against drift.** `tests/eval/conversationAgent.eval.test.ts` hand-assembles a copy of `conversationGraph` (same nodes, same model tiers, but `dispatch_research` routes to `END` so no researchers spawn). Nothing checks that the two still agree, and the file's own header says as much: rename or re-route a node in `src/conversationAgent.ts` and the eval keeps passing while testing wiring that no longer exists. Cheapest fix is a unit test comparing the two graphs' node and edge sets — no API calls needed.
- [ ] **Typecheck the tests.** `tsconfig.json` has `include: ["src/**/*"]`, so `npm run build` never sees `tests/`; type errors there surface only if vitest happens to execute that line.

### Hygiene

- [ ] **Add a README** — nothing currently tells a human what this project is or how to run it. Becomes a real gap when the project goes public.
- [ ] **Add CI** — tests pass and cost nothing (`tests/unit` is fully mocked), but nothing runs them automatically. Keep `tests/eval` out of CI; it makes real paid API calls.
- [ ] **Remove `console.log` from the production path** (`tavilySearch.ts:110-119`) or put it behind a verbosity flag — fine in Studio, noise in a deployed server.
- [ ] **Add `engines` / `.nvmrc`** — `langgraph.json` pins `node_version: "20"` but `package.json` declares nothing.
- [ ] **Drop `ANTHROPIC_API_KEY` from the local `.env` / `.env.example`** (or start using it) — every model currently routes through `ChatOpenAI` in `src/model.ts`. Both files are gitignored, so this is local hygiene plus the key list in `CLAUDE.md`.
- [ ] **Add a linter/formatter** — none configured.
- [ ] **Add a LICENSE** if "open to public" means open source.

## Done

- [x] **Deleted `plan.md`** (2026-09-26) — the stale original build plan at the repo root, not `src/plan.ts`, which is live code. It still described `clarify_with_user → write_research_brief`, architecture that no longer exists, and left three sections at "TBD"; being gitignored, it never reached a clone anyway. `CLAUDE.md` and this file cover its job.

- [x] **Collaborative scoping.** The scoping / plan-confirmation loop from the experimental `conversationAgentB` is now the front half of `src/conversationAgent.ts`: `scope_topic` ⇄ `ask_user` → `propose_plan` → `confirm_plan` → `classify_feedback` → `dispatch_research` → supervisor. `research_brief` and `briefing_node` are gone — the confirmed `plan` (`src/plan.ts`) is the single artifact handed to the research phase. `conversationAgentB.ts`, `conversationStateB.ts`, `clarificationPrompt.ts`, `briefingPrompt.ts` and the two clarification tests were deleted with it.
