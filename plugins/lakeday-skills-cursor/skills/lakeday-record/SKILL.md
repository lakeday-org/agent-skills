---
name: lakeday-record
description: Record what the agent learned and decided — session_decide, session_outcome, entity_fact, entity_link — with the evidence and idempotency keys Lakeday expects; the AGENTIC half of ALWAYS-mode learning.
license: MIT
---

## Record knowledge

### Source Of Truth

- The injected `<lakeday-knowledge>` block names the session ID and project entity to write to.
  Use those IDs verbatim.
- Contracts: https://docs.lakeday.ai/docs/built-ins/entities-sessions. Every write needs
  `tenant_id`, `id`, `idempotency_key`, and typed `data`.
- The hooks capture events, context, and provenance automatically. You own the content of
  decisions, outcomes, facts, and links. If you finish a turn that changed something without a
  decision, the Stop hook blocks once and tells you exactly what to call.

### Default Posture (after Agno's learning stores)

| Store | When to write | Tool |
| --- | --- | --- |
| Decision log | Any consequential choice: deploying, changing data, granting access, picking an approach, rejecting an alternative, committing code | `session_decide` |
| Outcomes | When a measurement lands after a decision: a query, a dashboard inspection, a test run, a metric | `session_outcome` |
| Entity memory | A durable fact about a thing that outlives this session: baselines, root causes, owners, schema quirks, "this file is generated" | `entity_fact` |
| Relationships | Structure another session would need: service depends on service, release changes service, dashboard reads table | `entity_link` |
| Learned knowledge | Transferable lessons about the project or the tools ("retries mask timeout regressions") | `entity_fact` on the project entity, predicate `learning` |
| Session context | Replaced automatically at Stop and PreCompact; write `session_context` yourself only to pin a plan (`plan: [...]`) or open questions (`open: [...]`) | `session_context` |

Rules:

- One decision per independent choice; never bundle "built pipeline and granted access".
- `choice` says what you did; `rationale` says why; `alternatives` lists what you rejected and why,
  in one clause each; `subjects` are the entity IDs affected; `evidence` cites datasets with
  versions, URLs, and prior decisions.
- Outcomes are measured, not hoped: "failure rate 8.4% → 0.6% across snapshots 42–43", not "should
  be fixed".
- Facts are claims with a predicate and a value, attributed to you, retractable. Correct a fact by
  retracting and asserting, not by editing.
- Keep bodies under 32 KiB and collections (subjects, evidence) under 64 entries. Large data stays
  in the lake; reference it.
- Idempotency keys are stable per logical write: `decide-restore-timeout-v1`. Retry with the same
  key and body; change the key when the body changes.

### Workflow

1. Before finishing a turn, list the consequential things you did (the hooks list them if you forget).
2. For each, call `session_decide`:
   ```json
   { "tenant_id": "<tenant>", "id": "<session id from the block>", "idempotency_key": "decide-restore-timeout-v1",
     "data": { "id": "restore-timeout", "actor_id": "<your actor from whoami>",
               "subjects": ["service:checkout", "release:v42"],
               "choice": "Restore the checkout timeout to 1,200 ms",
               "rationale": "v42 cut it to 200 ms; failures rose 0.6% → 8.4%; the May 12 incident showed valid payments exceed 200 ms",
               "alternatives": ["Add retries: masks latency and raises load", "Roll back v42 entirely: loses unrelated fixes"],
               "evidence": [{ "kind": "dataset", "id": "checkout_events", "version": "42" },
                            { "kind": "decision", "id": "prior-retry-decision", "session_id": "<earlier session>" }] } }
   ```
3. When a measurement follows, call `session_outcome` with `record_id` = the decision ID:
   ```json
   { "tenant_id": "<tenant>", "id": "<session id>", "record_id": "restore-timeout", "idempotency_key": "outcome-restore-timeout-v1",
     "data": { "outcome": "Failure rate returned to 0.6% (snapshot 43 vs 42)",
               "evidence": [{ "kind": "dataset", "id": "checkout_events", "version": "43" }] } }
   ```
4. Durable facts go on the right entity, not the session:
   `entity_fact(id="service:checkout", data={ id: "timeout-baseline", predicate: "timeout_baseline_ms", value: 1200, evidence: [...] })`.
5. Links make the graph: `entity_link(id="release:v42", data={ id: "changes-checkout", predicate: "changes", target: { kind: "entity", id: "service:checkout" } })`.
6. If publication lags, `session_sync` / `entity_sync` retries it; do not re-post.
7. No Lakeday MCP tools in this session? End the reply with fenced code blocks and the hook
   records them. Info string lakeday-decision: the decision JSON above without the envelope.
   Info string lakeday-outcome: `{ "decision_id", "outcome", "evidence" }`. Info string
   lakeday-fact: `{ "id", "predicate", "value", "entity"?, "evidence"? }`. One block per record.

### Related Skills

- `lakeday-knowledge` for the model and naming conventions.
- `lakeday-recall` to check for an existing decision before recording a duplicate.
- `lakeday-query` to obtain the measurement an outcome cites.
