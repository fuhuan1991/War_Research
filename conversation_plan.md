# Conversation-Scoping & Plan-Confirmation Subgraph — Node Plan

This document describes the node design for the pre-research phase of the
war-research agent: the part that runs **before** the actual research
sub-agent is invoked. As of the graph-B integration this is no longer a
separate experiment — it is the front half of `src/conversationAgent.ts`,
and node names below map to the implementation in snake_case (`ScopeTopic`
→ `scope_topic`, and so on). It covers three required behaviors:

1. Detect whether the user has given a workable, in-scope topic and clearly
   signaled they want to start (`ScopeTopic`).
2. If not, push back with a concrete, easy-to-answer suggestion rather than
   an open-ended question (`AskUser`).
3. Once a topic is accepted, propose a concrete research plan (final topic +
   at most `MAX_ANGLES_PER_PLAN` angles) and get explicit user confirmation before
   research begins (`ProposePlan` / `ConfirmPlan`). This step is **mandatory**,
   not optional.

Human-in-the-loop pauses use LangGraph's `interrupt()`, in two dedicated
nodes and only those two — `AskUser` and `ConfirmPlan`. Per
LangGraph's rules of interrupts, every node that calls `interrupt()` will be
re-executed from the top on resume, so LLM calls and `interrupt()` calls are
never mixed in the same node — each node does exactly one of those things.

---

## State fields

| Field | Type | Set by | Purpose |
|---|---|---|---|
| `messages` | `list[AnyMessage]` (reducer: append) | all nodes | Full conversation history; every LLM judgment is made against this, not just the latest turn |
| `ready_to_plan` | `bool` | `ScopeTopic` | Whether a workable topic has been established |
| `rough_topic` | `str \| None` | `ScopeTopic`; cleared by `ClassifyFeedback` on topic-level feedback | Rough topic distilled from the full conversation once `ready_to_plan = True` |
| `pending_question` | `str \| None` | `ScopeTopic` | The suggestive prompt shown to the user by `AskUser` when not ready |
| `plan` | `{final_topic: str, angles: list[str]} \| None` | `ProposePlan` | The concrete research plan shown for confirmation |
| `plan_confirmed` | `bool` | `ClassifyFeedback` (on approval) / `ProposePlan` (cap case) | Whether the user has approved the current plan. `ConfirmPlan` never writes it — it holds no logic of its own |
| `confirm_rounds` | `int` | `ClassifyFeedback` | Number of times the user has rejected a proposed plan; used for the round cap. Reset to 0 on topic-level feedback |
| `clarify_rounds` | `int` | `ScopeTopic`; reset by `ClassifyFeedback` on topic-level feedback | Number of nudges spent; bounds the clarification loop against `MAX_CLARIFY_ROUNDS` so an unsatisfiable user is not redirected forever — once it is spent, `ScopeTopic` routes to `END` |

---

## Nodes

### 1. `ScopeTopic` (LLM call — no interrupt)

**Responsibility:** decide whether the conversation so far contains a
workable topic.

- Reads the **entire** `messages` history (the topic may be established
  across several turns, not just the last message).
- Calls an LLM with structured output checking **one** condition: is there a
  specific, in-scope topic (not too vague, not too broad, not off-topic —
  e.g. "trade war" is rejected as not a real armed conflict)?
- **Defaults to proceeding.** It does not require the user to ask it to
  start, and does not ask them to confirm that they want research. A bare
  statement of a conflict is the request. `ConfirmPlan` is already the
  consent gate and a better-informed one — it shows the plan first — so a
  second "shall I?" here would cost the user a round-trip and a clarify
  round to learn nothing. The single exception is an **explicit hold**
  ("just curious", "don't research this yet"), which is taken at face value.
- If the condition fails: writes a **suggestive** `pending_question`
  (e.g. "WWII is a huge topic — want to focus on the Pacific theater
  instead?") rather than an open question, appends it to `messages` as an
  AI turn, sets `ready_to_plan = False`.
- If it holds: sets `ready_to_plan = True` and `rough_topic` to the
  synthesized topic.
- Routes: `ready_to_plan = True` → `ProposePlan`. `ready_to_plan = False` →
  `AskUser`, unless `clarify_rounds` has already reached
  `MAX_CLARIFY_ROUNDS`, in which case the loop is over: it routes to `END`
  with a closing message instead of nudging again.

### 2. `AskUser` (interrupt only)

**Responsibility:** pause and collect the user's reply to `pending_question`.

- Calls `interrupt()` with `pending_question` as the payload. Nothing else.
- On resume, appends the answer to `messages` as a human turn.
- Routes back to `ScopeTopic` unconditionally, forming the clarification
  loop.
- Safe to re-run from the top on resume — it has no other logic.

### 3. `ProposePlan` (LLM call — no interrupt)

**Responsibility:** turn the accepted topic into a concrete, presentable
research plan; also enforces the confirmation round cap.

- Always calls the LLM first, with structured output, to produce `plan =
  {final_topic, angles}` from `rough_topic` plus the full `messages` history
  (which may already contain feedback from a prior rejected plan — the LLM
  should incorporate it into the new version). The round cap governs whether
  the resulting plan is put to the user, not whether it gets built.
- Caps `angles` at `MAX_ANGLES_PER_PLAN`. Both the prompt and the schema ask
  for at most that many, but neither is a constraint the model is bound by,
  and every surplus angle would otherwise become another researcher
  downstream. The cap is one-sided: a plan with FEWER angles passes through
  untouched, because a topic that only supports two angles worth researching
  should get two rather than a padded third.
- Then checks `confirm_rounds` against the cap (pure logic, no LLM needed
  for this check).
- If `confirm_rounds` is under the cap: leaves `plan_confirmed` unset,
  renders the plan **and the confirmation question** into `messages`, and
  routes to `ConfirmPlan`. The question goes into `messages` rather than
  living only in the interrupt payload, so a UI rendering the message
  stream shows the user what they are being asked.
- If `confirm_rounds` has reached the cap: sets `plan_confirmed = True`
  directly (auto-accepts the latest synthesized plan) and routes straight to
  `Research`, skipping further confirmation.

### 4. `ConfirmPlan` (interrupt only)

**Responsibility:** pause and collect the user's free-text reply to the
proposed plan. The exact counterpart of `AskUser`.

- Calls `interrupt()` with the confirmation question as the payload.
  Nothing else — no LLM call, no interpretation of the reply at all.
- Resume value is free text: "approve", "looks good", "replace angle 2
  with X", "wrong war" — anything.
- On resume, appends the reply to `messages` as a human turn and routes to
  `ClassifyFeedback` unconditionally, via a plain edge.
- Deciding whether that text was an approval requires an LLM, and an
  interrupting node cannot hold one — hence the split.

### 5. `ClassifyFeedback` (LLM call — no interrupt)

**Responsibility:** read the user's reply to the proposed plan and decide
whether it approves the plan, asks for different angles, or rejects the
topic itself, and route accordingly. This is kept as
its own node rather than logic inside a conditional-edge function, for the
same reason `ScopeTopic` and `AskUser` are split: any LLM call gets its own
node so it is independently checkpointed and re-runnable.

- Calls an LLM against the full `messages` history to classify the latest
  reply as one of:
  - **approve** — the user accepts the plan as proposed (e.g. "approve",
    "looks good", "go ahead"),
  - **angle-level** — the topic still stands, only the angles need
    adjusting (e.g. "swap angle B for a civilian perspective"), or
  - **topic-level** — the user is rejecting the topic itself (e.g. "this
    isn't the right topic, let's pick something else").
- Approve: sets `plan_confirmed = True`, routes to `Research`.
- Angle-level: increments `confirm_rounds` and routes to `ProposePlan`
  (regenerate the plan for the same topic). This is the only path that
  spends a confirmation round, so approving costs nothing against the cap.
- Topic-level: discards the negotiation so far — `ready_to_plan`,
  `rough_topic`, `plan` and `plan_confirmed` are all cleared, and **both**
  counters (`confirm_rounds` and `clarify_rounds`) go back to 0 — then routes
  back to `ScopeTopic` to renegotiate the topic using the latest feedback. A
  genuinely new subject gets a fresh clarification and confirmation budget
  rather than inheriting the exhausted one from the abandoned topic.

### 6. `Research` (implemented as `dispatch_research` → `supervisor_agent`)

**Responsibility:** do the real work, using the confirmed plan.

- Only reachable once `plan_confirmed = True` (either by an approval
  recognized in `ClassifyFeedback`, or by the round-cap auto-accept in
  `ProposePlan`).
- Implemented as two nodes rather than one. `dispatch_research` holds no
  LLM call: it renders the confirmed plan through `planToBrief()` into the
  single `HumanMessage` that seeds `supervisor_messages`, and hands off to
  the `supervisor_agent` subgraph. Both routes into research pass through
  it, so the hand-off exists in exactly one place.
- **Known gap:** the supervisor still derives its own sub-topics from that
  seed message, so the approved angles are a strong suggestion rather than a
  guarantee. The intended fix is for the supervisor to emit one
  `ConductResearch` call per angle on its first turn, skipping that turn's
  LLM dispatch — which is why the angle count is capped by
  `MAX_ANGLES_PER_PLAN` and aligned with `MAX_CONCURRENT_RESEARCH_UNITS`.
  Note the supervisor must cope with fewer angles than the cap.
- This is the node most likely to be expensive/long-running (and, if the
  sub-agent is itself a LangGraph subgraph with its own `interrupt()`
  calls, it is deliberately isolated from `ScopeTopic` / `ProposePlan` so
  that a nested interrupt/resume inside the sub-agent never forces those
  LLM-calling nodes to re-run).

---

## Routing diagram

```
START -> ScopeTopic

ScopeTopic --not ready--> AskUser --> ScopeTopic          (clarification loop)
ScopeTopic --MAX_CLARIFY_ROUNDS spent--> END              (give up, not converging)
ScopeTopic --ready------> ProposePlan

ProposePlan --under cap-----> ConfirmPlan
ProposePlan --cap reached---> Research                     (auto-accept)

ConfirmPlan --------------> ClassifyFeedback               (always; free-text reply)

ClassifyFeedback --approve-----> Research
ClassifyFeedback --angle-level--> ProposePlan               (plan revision loop; confirm_rounds +1)
ClassifyFeedback --topic-level--> ScopeTopic                (topic renegotiation; both counters reset)

Research = dispatch_research -> supervisor_agent -> report_generator -> END
```

---

## Design notes carried over from the interrupt-usage discussion

- **One concern per node.** Every node either calls the LLM or calls
  `interrupt()` — never both — because a node re-executes from the start on
  resume, and repeating an LLM call on every resume is wasteful and
  non-deterministic.
- **`messages` always drives judgment.** `ScopeTopic` and `ClassifyFeedback`
  both read the full history, not just the latest turn, since the topic and
  the nature of feedback are often established across multiple turns.
- **The round cap lives in `ProposePlan`, not `ConfirmPlan`.** The cap check
  is deterministic logic, so it stays out of the interrupt-only node and
  out of a conditional-edge function, keeping `ConfirmPlan` minimal and
  `ProposePlan`'s behavior (revise vs. auto-accept) explicit and testable.
- **`Research` is isolated from the negotiation loop.** If the research
  sub-agent is itself an interruptible subgraph, none of its internal
  pause/resume cycles should force `ScopeTopic` or `ProposePlan` to
  re-run — this is why plan confirmation is fully resolved before
  `Research` is ever entered.
