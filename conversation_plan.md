# Conversation-Scoping & Plan-Confirmation Subgraph — Node Plan

This document describes the node design for the pre-research phase of the
war-research agent: the part that runs **before** the actual research
sub-agent is invoked. It covers three required behaviors:

1. Detect whether the user has given a workable, in-scope topic and clearly
   signaled they want to start (`ReadyOrNot`).
2. If not, push back with a concrete, easy-to-answer suggestion rather than
   an open-ended question (`AskUser`).
3. Once a topic is accepted, propose a concrete research plan (final topic +
   angles) and get explicit user confirmation before research begins
   (`ProposePlan` / `ConfirmPlan`). This step is **mandatory**, not optional.

All nodes use LangGraph's `interrupt()` for human-in-the-loop pauses. Per
LangGraph's rules of interrupts, every node that calls `interrupt()` will be
re-executed from the top on resume, so LLM calls and `interrupt()` calls are
never mixed in the same node — each node does exactly one of those things.

---

## State fields

| Field | Type | Set by | Purpose |
|---|---|---|---|
| `messages` | `list[AnyMessage]` (reducer: append) | all nodes | Full conversation history; every LLM judgment is made against this, not just the latest turn |
| `ready` | `bool` | `ReadyOrNot` | Whether the topic + intent-to-start conditions are both met |
| `topic` | `str \| None` | `ReadyOrNot` | Rough topic distilled from the full conversation once `ready = True` |
| `pending_question` | `str \| None` | `ReadyOrNot` | The suggestive prompt shown to the user by `AskUser` when not ready |
| `plan` | `{final_topic: str, angles: list[str]} \| None` | `ProposePlan` | The concrete research plan shown for confirmation |
| `plan_confirmed` | `bool` | `ConfirmPlan` / `ProposePlan` (cap case) | Whether the user has approved the current plan |
| `confirm_rounds` | `int` | `ConfirmPlan` | Number of times the user has rejected a proposed plan; used for the round cap |

---

## Nodes

### 1. `ReadyOrNot` (LLM call — no interrupt)

**Responsibility:** decide whether the conversation so far contains a
workable topic and a clear signal to start.

- Reads the **entire** `messages` history (topic and intent may be
  established across several turns, not just the last message).
- Calls an LLM with structured output checking two conditions independently:
  1. Is there a specific, in-scope topic (not too vague, not too broad, not
     off-topic — e.g. "trade war" is rejected as not a real armed conflict)?
  2. Has the user clearly signaled they want to proceed?
- If either condition fails: writes a **suggestive** `pending_question`
  (e.g. "WWII is a huge topic — want to focus on the Pacific theater
  instead?") rather than an open question, appends it to `messages` as an
  AI turn, sets `ready = False`.
- If both conditions hold: sets `ready = True` and `topic` to the
  synthesized topic.
- Routes: `ready = False` → `AskUser`; `ready = True` → `ProposePlan`.

### 2. `AskUser` (interrupt only)

**Responsibility:** pause and collect the user's reply to `pending_question`.

- Calls `interrupt()` with `pending_question` as the payload. Nothing else.
- On resume, appends the answer to `messages` as a human turn.
- Routes back to `ReadyOrNot` unconditionally, forming the clarification
  loop.
- Safe to re-run from the top on resume — it has no other logic.

### 3. `ProposePlan` (LLM call — no interrupt)

**Responsibility:** turn the accepted topic into a concrete, presentable
research plan; also enforces the confirmation round cap.

- First checks `confirm_rounds` against the cap (pure logic, no LLM needed
  for this check).
- Calls an LLM with structured output to produce `plan = {final_topic,
  angles}` from `topic` plus the full `messages` history (which may already
  contain feedback from a prior rejected plan — the LLM should incorporate
  it into the new version).
- If `confirm_rounds` is under the cap: leaves `plan_confirmed` unset,
  routes to `ConfirmPlan`.
- If `confirm_rounds` has reached the cap: sets `plan_confirmed = True`
  directly (auto-accepts the latest synthesized plan) and routes straight to
  `Research`, skipping further confirmation.

### 4. `ConfirmPlan` (interrupt only)

**Responsibility:** show the plan and capture the user's approve/reject
decision.

- Calls `interrupt()` with the plan payload (`final_topic`, `angles`) and a
  confirmation question. Nothing else — no LLM call, no interpretation
  logic beyond checking the resume value's shape.
- Resume value is one of two shapes: an explicit approval signal, or free
  text feedback.
- Approval: sets `plan_confirmed = True`, routes to `Research`.
- Feedback: increments `confirm_rounds`, appends the feedback as a human
  turn, sets `plan_confirmed = False`, routes to `ClassifyFeedback`.

### 5. `ClassifyFeedback` (LLM call — no interrupt)

**Responsibility:** decide whether rejection feedback is about the plan's
angles or about the topic itself, and route accordingly. This is kept as
its own node rather than logic inside a conditional-edge function, for the
same reason `ReadyOrNot` and `AskUser` are split: any LLM call gets its own
node so it is independently checkpointed and re-runnable.

- Calls an LLM against the full `messages` history to classify the latest
  feedback as either:
  - **angle-level** — the topic still stands, only the angles need
    adjusting (e.g. "swap angle B for a civilian perspective"), or
  - **topic-level** — the user is rejecting the topic itself (e.g. "this
    isn't the right topic, let's pick something else").
- Angle-level: routes to `ProposePlan` (regenerate the plan for the same
  topic; `confirm_rounds` is left as-is since it was already incremented in
  `ConfirmPlan`).
- Topic-level: resets `confirm_rounds` to 0 (a new topic starts a fresh
  confirmation cycle) and routes back to `ReadyOrNot` to renegotiate the
  topic using the latest feedback.

### 6. `Research` (action node — invokes the actual research sub-agent)

**Responsibility:** do the real work, using the confirmed plan.

- Only reachable once `plan_confirmed = True` (either by explicit user
  approval, or by the round-cap auto-accept in `ProposePlan`).
- Invokes the research sub-agent with `plan.final_topic` and `plan.angles`.
- This is the node most likely to be expensive/long-running (and, if the
  sub-agent is itself a LangGraph subgraph with its own `interrupt()`
  calls, it is deliberately isolated from `ReadyOrNot` / `ProposePlan` so
  that a nested interrupt/resume inside the sub-agent never forces those
  LLM-calling nodes to re-run).

---

## Routing diagram

```
START -> ReadyOrNot

ReadyOrNot --not ready--> AskUser --> ReadyOrNot          (clarification loop)
ReadyOrNot --ready------> ProposePlan

ProposePlan --under cap-----> ConfirmPlan
ProposePlan --cap reached---> Research                     (auto-accept)

ConfirmPlan --approved-------> Research
ConfirmPlan --feedback-------> ClassifyFeedback

ClassifyFeedback --angle-level--> ProposePlan               (plan revision loop)
ClassifyFeedback --topic-level--> ReadyOrNot                (topic renegotiation; confirm_rounds reset)
```

---

## Design notes carried over from the interrupt-usage discussion

- **One concern per node.** Every node either calls the LLM or calls
  `interrupt()` — never both — because a node re-executes from the start on
  resume, and repeating an LLM call on every resume is wasteful and
  non-deterministic.
- **`messages` always drives judgment.** `ReadyOrNot` and `ClassifyFeedback`
  both read the full history, not just the latest turn, since the topic and
  the nature of feedback are often established across multiple turns.
- **The round cap lives in `ProposePlan`, not `ConfirmPlan`.** The cap check
  is deterministic logic, so it stays out of the interrupt-only node and
  out of a conditional-edge function, keeping `ConfirmPlan` minimal and
  `ProposePlan`'s behavior (revise vs. auto-accept) explicit and testable.
- **`Research` is isolated from the negotiation loop.** If the research
  sub-agent is itself an interruptible subgraph, none of its internal
  pause/resume cycles should force `ReadyOrNot` or `ProposePlan` to
  re-run — this is why plan confirmation is fully resolved before
  `Research` is ever entered.
