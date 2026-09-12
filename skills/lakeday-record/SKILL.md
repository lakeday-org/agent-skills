---
name: lakeday-record
description: Record what the agent learned and decided — decisions on the object they are about, outcomes, facts, and links — with the evidence and idempotency keys Lakeday expects; the AGENTIC half of ALWAYS-mode learning.
license: MIT
---

## Record knowledge

### Source Of Truth

- The injected `<lakeday-knowledge>` block names the session ID and project object to write to.
  Use those IDs verbatim.
- Contracts: https://docs.lakeday.ai/docs/built-ins/entities-sessions. Every write needs
  `tenant_id`, `id`, `idempotency_key`, and typed `data`.
- The hooks capture the turn's shape automatically. You own the content of decisions, outcomes,
  facts, and links. If you finish a turn that changed something without a decision, the Stop hook
  blocks once and tells you exactly what to call.

### Write a decision on the object it is about

This is the rule that shapes everything else. A decision about the checkout service is recorded on
`service:checkout`; a decision about this repository is recorded on the project object from the
injected block. Not on the session. The session is named in `about` so the decision still points
back at where it was made.

`entity_decide` and `session_decide` are the same operation on the same class — pick the namespace
that matches the object you are writing to.

### Default Posture (after Agno's learning stores)

| Store | When to write | Tool |
| --- | --- | --- |
| Decision log | Any consequential choice: deploying, changing data, granting access, picking an approach, rejecting an alternative, committing code | `entity_decide` on the affected object |
| Outcomes | When a measurement lands after a decision: a query, a dashboard inspection, a test run, a metric | `entity_outcome` on the same object |
| Entity memory | A durable fact about a thing that outlives this session: baselines, root causes, owners, schema quirks | `entity_fact` |
| Links | Structure another session would need: service depends on service, release changes service, dashboard reads table | `entity_link` |
| Learned knowledge | Transferable lessons about the project or the tools ("retries mask timeout regressions") | `entity_fact` on the project object, predicate `learning` |
| Session context | Write `session_context` to pin a plan (`plan: [...]`) or open questions (`open: [...]`) | `session_context` |
| Observations | A notable action result or error worth replaying later | `session_log` |

Rules:

- One decision per independent choice; never bundle "built pipeline and granted access".
- `choice` says what you did; `rationale` says why; `alternatives` lists what you rejected and why,
  in one clause each.
- `data.id` is the decision's own record ID in short kebab-case. It is **never** the session ID.
- Outcomes are measured, not hoped: "failure rate 8.4% → 0.6% across snapshots 42–43", not "should
  be fixed".
- Facts are claims with a predicate and a value, attributed to you, retractable. Correct a fact by
  retracting and asserting, not by editing.
- Keep bodies under 32 KiB and `evidence` under 32 entries. Large data stays in the lake; cite it.
- Idempotency keys are stable per logical write: `decide-restore-timeout-v1`. Retry with the same
  key and body; change the key when the body changes.

### Workflow

1. Before finishing a turn, list the consequential things you did (the hooks list them if you forget).
2. For each, identify the object it is about, then call `entity_decide` on that object:
   ```json
   { "tenant_id": "<tenant>", "id": "service:checkout", "idempotency_key": "decide-restore-timeout-v1",
     "data": { "id": "restore-timeout", "actor_id": "<your actor from whoami>",
               "about": "<session id from the block>",
               "choice": "Restore the checkout timeout to 1,200 ms",
               "rationale": "v42 cut it to 200 ms; failures rose 0.6% → 8.4%; the May 12 incident showed valid payments exceed 200 ms",
               "alternatives": ["Add retries: masks latency and raises load", "Roll back v42 entirely: loses unrelated fixes"],
               "evidence": [{ "object": "dataset:checkout_events", "point": 42 },
                            { "object": "release:v42" }] } }
   ```
3. When a measurement follows, call `entity_outcome` on the same object with `record_id` = the
   decision's record ID:
   ```json
   { "tenant_id": "<tenant>", "id": "service:checkout", "record_id": "restore-timeout",
     "idempotency_key": "outcome-restore-timeout-v1",
     "data": { "actor_id": "<your actor>", "outcome": "Failure rate returned to 0.6% (snapshot 43 vs 42)",
               "evidence": [{ "object": "dataset:checkout_events", "point": 43 }] } }
   ```
4. Durable facts go on the thing they describe:
   `entity_fact(id="service:checkout", data={ id: "timeout-baseline", actor_id: "<actor>", predicate: "timeout_baseline_ms", value: 1200, evidence: [...] })`.
5. Links make the graph, and name the other object directly:
   `entity_link(id="release:v42", data={ id: "changes-checkout", actor_id: "<actor>", predicate: "changes", about: "service:checkout" })`.
6. A write is durable when it returns. There is nothing to sync, publish, or repair afterwards —
   a `503` marked `retryable` means retry with the same `idempotency_key`.
7. No Lakeday MCP tools connected? Say so once and continue without recording. Do not invent a
   transport.

### Related Skills

- `lakeday-knowledge` for the model and naming conventions.
- `lakeday-recall` to check for an existing decision before recording a duplicate.
- `lakeday-query` to obtain the measurement an outcome cites.
