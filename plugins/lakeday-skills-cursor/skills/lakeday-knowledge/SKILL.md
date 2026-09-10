---
name: lakeday-knowledge
description: The Lakeday knowledge model — Entities, Facts, Relationships, Sessions, Decisions, Outcomes, and Datasets — with naming conventions and the ALWAYS capture contract the hooks enforce.
license: MIT
---

## Lakeday knowledge model

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/built-ins/entities-sessions and
  https://docs.lakeday.ai/docs/concepts/mcp#entities-and-sessions.
- The `<lakeday-knowledge>` block injected at the start of each turn is the projected state of the
  current session. Trust it over your own memory of earlier turns; it is rebuilt from durable events.
- Research basis: Tardigrade's actor/thread model (state projected from immutable events),
  Agno's learning machines (session context, entity memory, decision logs, learned knowledge).

### The seven layers

| Layer | Lakeday object | Written by | Read with |
| --- | --- | --- | --- |
| Datasets | Lance tables, streams, external sources; referenced as `{kind:"dataset", id, version}` | pipelines, `stream_load`, hooks (provenance) | `query_describe`, `query_sql` |
| Entities | Entity DO: one per thing (`repo:`, `service:`, `pipeline:`, `dataset:`, `dashboard:`, `release:`, `user`) | `entity_create`, hooks | `entity_get`, `lk_knowledge` |
| Facts | Attributed `predicate → value` assertions on an entity, retractable | `entity_fact` (model) | `entity_facts`, SQL |
| Relationships | Explicit graph edges `entity —predicate→ reference` | `entity_link`, hooks (`reads_from`, `writes_to`, `produced_by`, `loaded_from`, `owns`) | `entity_relationships`, SQL |
| Sessions | One interaction's full event history plus a replaceable context | hooks (`session_create`, `session_append`, `session_context`) | `session_project`, `session_get`, `session_history` |
| Decisions | `(session_id, decision_id)`: choice, rationale, alternatives, subjects, evidence | `session_decide` (model, enforced by hooks) | `session_decisions`, `entity_decisions` |
| Outcomes | Measured result attached to a decision | `session_outcome` (model, prompted by hooks) | `session_outcomes`, SQL |

### Naming conventions

- Entity IDs: `<type>:<slug>` using `[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}`. Examples:
  `repo:checkout`, `service:checkout`, `pipeline:checkout-ingest`, `dataset:checkout_events`,
  `dataset:s3-bucket/checkout-events.jsonl`, `dashboard:checkout-health`, `release:v42`.
- Personal deployments prefix IDs with the owner prefix automatically; use the IDs exactly as they
  appear in the injected block and in tool results.
- Decision IDs: short kebab-case verbs, `restore-timeout`, `build-ingest-pipeline`, one per
  independent choice.
- Fact predicates: `snake_case` nouns, `timeout_baseline_ms`, `failure_rate_pct`, `root_cause`.
- Session IDs are assigned by the hooks (`<prefix><harness>-<project>-<id>`) and shown in the
  injected block. Never invent a session ID.

### Provenance is stored, not asserted

- `actor_id` is bound by the server to the authenticated user; it is provenance, not an ACL.
- Every mutation needs a stable `idempotency_key`; retry with the same key and body.
- References may precede their targets: cite a dataset version before the table exists.
- Retractions keep the original attribution. Disagreement is a new assertion, not an edit.

### ALWAYS contract (what the hooks do without asking)

Modeled on Agno `LearningMode.ALWAYS`: extraction runs on every turn, not when the agent feels like it.

- **SessionStart / prompt**: the session exists, the project entity exists, the user prompt is an
  event, and the projected context is injected.
- **Tool calls**: consequential Lakeday calls, errors, code edits, and git mutations become
  `tool.result` events with dataset evidence. `deploy_pipeline`, `run_pipeline`,
  `create_dashboard`, and `set_table_policy` create entities and lineage links server-side
  (pass `session_id` and `project_entity`); the hooks add the same for `stream_load`.
- **Stop**: the assistant's turn text is an event; the session context is replaced with a fresh
  summary (goal, decisions, datasets, open errors). If the turn changed anything and no decision was
  recorded, the stop is blocked once with the exact call to make.
- **PreCompact**: the context snapshot is written before the harness compacts, so nothing depends on
  the transcript surviving.

What the model still owns (the AGENTIC layer): the content of decisions, outcomes, facts, and links.
See `lakeday-record`.

One implementation, three surfaces: the SDK module `@lakeday-org/worker-js/learning` is what
`defineAgent({ learning: "always" })` uses inside Lakeday's V8 agents, what the MCP server's
`session_project` and provenance use, and what these hooks import directly.

### Related Skills

- `lakeday-record` for when and how to write decisions, outcomes, facts, and links.
- `lakeday-recall` for reading knowledge before acting.
- `lakeday-query` for SQL over `lk_knowledge`.
