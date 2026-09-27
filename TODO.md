# TODO

Living backlog of action items for the War Research project. Add items here as they come up; check them off (or delete) once done. See `CLAUDE.md` for architecture context.

## Open

- [ ] **Output quality: prose over bullet lists.** Final reports currently read as large bullet lists; expectation is a few paragraphs / short-article style. `reportGeneratorPrompt` (`src/prompts/reportGeneratorPrompt.ts`) already says "write in paragraph form" but the report is likely inheriting bullet-heavy style from the researcher's `compressed_research` notes feeding into it — needs investigation into both `researcherCompressionPrompt.ts` and `reportGeneratorPrompt.ts`.
- [ ] **Output should include images.** No image capability exists anywhere in the pipeline today — Tavily search is text-only (`src/tools/tavilySearch.ts`), and no prompt references embedding images. Needs a design decision: image search API (Tavily supports `includeImages`), how images get carried through `raw_notes`/`notes` state, and how the final report embeds them (markdown `![]()` with source URLs vs. downloading/storing).
- [ ] **Make the supervisor research the angles the user approved.** `dispatch_research` (`src/conversationAgent.ts`) hands the supervisor the confirmed plan as prose via `planToBrief()`, but `supervisor_node` still derives its own sub-topics from it — so the angles the user saw and approved are a suggestion, not a guarantee. Fix: have the supervisor emit one `ConductResearch` call per angle on its first turn, skipping that turn's LLM dispatch entirely, then let the normal assess → dispatch loop take over for gap-filling. `MAX_ANGLES_PER_PLAN` is 3 to match `MAX_CONCURRENT_RESEARCH_UNITS`, but it is now a ceiling rather than a fixed count, so the supervisor must handle a plan with fewer angles than that.

- [ ] **Angle quality: remaining gaps.** The genericness problem is fixed (see the Done
  entry below). Two things measurement did *not* settle:
  - **Over-narrow angles may have thin source coverage.** The anti-generic rules push
    toward named particulars; an angle can now be specific enough that Tavily returns
    little. No judge measures this — it needs an actual research run, not a
    `propose_plan` call, so it is invisible to the current eval.
  - **Breadth versus the ceiling, on broad questions.** A genuinely broad question ("what
    was daily life like for soldiers in WWII") cannot be covered by `MAX_ANGLES_PER_PLAN`
    contested particulars: the angle that stretches to span it is the one that comes back
    generic. `proposePlanPrompt` now states a priority for this — at most one angle may
    trade its anchor for breadth, otherwise narrow `final_topic` and let the user object at
    `confirm_plan` — but the model follows it only sometimes. That seed still scores
    anywhere from 1/3 to 3/3 on `specific` while the narrower seeds sit at 3/3, which is
    why the eval threshold is an aggregate. Raising `MAX_ANGLES_PER_PLAN` would relieve it,
    at the cost of one more concurrent researcher per plan.
  - **The `intent` judge partly measures coverage, and flips about one run in three on the
    Gettysburg seed.** When it fails it says the plan "does not comprehensively cover" the
    third day — true (Culp's Hill is absent) but that is collective exhaustiveness, which
    is explicitly not a target. The assertion therefore requires 2 of 3 seeds rather than
    all 3. If CE is ever adopted as a goal, this judge is already most of the instrument.
  - **Gaps (the "CE" half) are not addressed and were deliberately dropped as a target.**
    With at most 3 angles, collective exhaustiveness is unreachable for most topics, and
    for open questions ("why was Napoleon better than his contemporaries") it is not even
    well defined — there is no finite set of dimensions whose union is the topic. The
    working assumption is that `confirm_plan` covers this: a user reading three angles
    spots a missing dimension easily, and `classify_feedback` routes that as angle-level
    feedback. Revisit only if that assumption proves false in practice.

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
- [ ] **Add *unit* tests for the remaining pre-research nodes and `report_generator`.** `propose_plan` is now covered by `tests/unit/conversationAgent.test.ts` (angle ceiling, shorter plans passing through, both routes out). Still missing: `scope_topic` (three statuses + `MAX_CLARIFY_ROUNDS` give-up), `classify_feedback` (approve / angle / topic routing and counter resets), `dispatch_research`, `report_generator`. All take an injected model, so they're cheap to cover. `tests/eval/conversationAgent.eval.test.ts` now covers this layer end-to-end against real LLMs — including the explicit-hold and bare-specific-topic cases — but it costs money per run, so the cheap mocked path is still missing.
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

- [x] **Make the proposed angles specific rather than generic.** `propose_plan` produced
  angles that named nothing inside their subject — "both Union and Confederate leaders",
  "soldiers on the front lines", "Napoleon's leadership style" — headings that fit any war
  ever fought. Measured at **1/9** on three unalike seeds before the change and **7-8/9**
  after. The fix is entirely in `proposePlanPrompt`: name instances rather than categories,
  and pick particulars that are *contested* rather than merely famous (those two rules pull
  against each other on purpose — the most specific things are usually the most
  written-about). `ANGLES_PER_PLAN` also became `MAX_ANGLES_PER_PLAN`: a ceiling rather than
  a quota, so a topic that only supports two angles gets two. Scored by
  `tests/eval/conversationAgent.eval.test.ts` against the judges in `tests/eval/angleJudges.ts`.

  Three decisions worth not re-deriving:
  - **No partition axis.** The original idea was to force one cut — phases, levels of war,
    actors — but no fixed enum spans the topic space. "What was a soldier's life like in
    WWII" and "why was Napoleon better than his contemporaries" have no shared axis with a
    battle, and a misfitting axis is *worse* than none: the model still has to fill the
    cells, so it either invents an empty one or relabels its usual output, which
    manufactures a guarantee that does not hold. The anti-generic rules replace it because
    they are tests the model applies to its own output, not branches on the kind of question
    — so they need no taxonomy of user questions.
  - **Question-level mutual exclusivity was already fine: 9/9 before the change.** The
    planned fix for it — widening `PlanSchema` so each angle carries a scope note saying
    what it leaves to the others — was dropped on that evidence rather than built. Note the
    measurement is *question*-level overlap; source-level overlap is unmeasured and would
    need a real research run to see.
  - **Genericness was the common cause.** Two generic angles collide *because* neither is
    specialised, so fixing genericness was expected to carry overlap with it — and overlap
    stayed at 9/9 while specificity went from 1/9 to 7-8/9.


- [x] **Deleted `plan.md`** (2026-09-26) — the stale original build plan at the repo root, not `src/plan.ts`, which is live code. It still described `clarify_with_user → write_research_brief`, architecture that no longer exists, and left three sections at "TBD"; being gitignored, it never reached a clone anyway. `CLAUDE.md` and this file cover its job.

- [x] **Collaborative scoping.** The scoping / plan-confirmation loop from the experimental `conversationAgentB` is now the front half of `src/conversationAgent.ts`: `scope_topic` ⇄ `ask_user` → `propose_plan` → `confirm_plan` → `classify_feedback` → `dispatch_research` → supervisor. `research_brief` and `briefing_node` are gone — the confirmed `plan` (`src/plan.ts`) is the single artifact handed to the research phase. `conversationAgentB.ts`, `conversationStateB.ts`, `clarificationPrompt.ts`, `briefingPrompt.ts` and the two clarification tests were deleted with it.
