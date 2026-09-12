---
name: lakeday-knowledge
description: The Lakeday object model — one event-sourced class carrying a kind tag, with facts, links, decisions, outcomes, and logs — plus naming conventions and the ALWAYS capture contract the hooks enforce.
license: MIT
---

## Lakeday object model

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/built-ins/entities-sessions and
  https://docs.lakeday.ai/docs/concepts/mcp#entities-and-sessions.
- The `<lakeday-knowledge>` block injected at the start of each turn is the projected state of the
  current session. Trust it over your own memory of earlier turns; it is rebuilt from durable events.
- Research basis: Tardigrade's actor/thread model (state projected from immutable events),
  Agno's learning machines (session context, entity memory, decision logs, learned knowledge).

### One class, one reference shape

Everything durable is **one object**: an identity, a `kind` tag, and an append-only event log.
A session is an object tagged `session`, not a separate type. A user is an object tagged `user`.
Kinds seen in practice: `user`, `repo`, `session`, `worker`, `table`, `dataset`, `pipeline`,
`dashboard`, `stream`.

`entity_*` and `session_*` are two namespaces into that same class, so **both accept the same
operations**:

| Operation | Tool suffix | Notes |
| --- | --- | --- |
| Create | `_create` | `data: { kind, name }` |
| Read identity | `_get` | folded from the object's own events |
| Read history | `_history` | oldest first, `after`/`limit` paged |
| Rename | `_update` | retains history |
| Assert / read facts | `_fact`, `_facts`, `_retract_fact` | class read is newest first |
| Assert / read links | `_link`, `_links`, `_retract_link` | class read is newest first |
| Record / read decisions | `_decide`, `_decisions`, `_decision` | recorded on the object the decision is *about* |
| Attach / read outcomes | `_outcome`, `_outcomes` | keyed by the decision's record ID |
| Append / read log | `_log` | observations and action results |
| Replace context | `_context` | current working context, prior retained |
| Events referencing X | `_refs` | this object's own events that name another object |

A reference is always **an object, optionally at a point in its own history**. There are no
reference kinds:

- On an event: `about: "<object id>"`, plus optional `about_point` (a record ID or a positive
  sequence).
- In a citation list: `evidence: [{ object: "<id>", point?: <record id | sequence> }]`, at most 32.

That one shape covers pointing at a decision, a table version, or another object.

### Decisions live on their subject

A decision is recorded on the object it is about, not inside the session that made it. "Prior
decisions about this repository" is that repository's own `entity_decisions` — a read of one
object, not a cross-object index.

Its identity is that object plus the decision's record ID. Attribution travels in `actor_id`, and
the originating session travels as `about` or in `evidence`.

### Every object holds the only copy of its history

There is no shared knowledge table, no published mirror, and no projection to repair. Each object's
own storage is the single copy, and **a projection is a query evaluated when asked**:
`session_project` folds a bounded context block from a session's own history plus a project
object's own facts and decisions. Nothing is stored by that call.

Two read orders, and the difference matters:

- **Class reads** (`_facts`, `_links`, `_decisions`, `_log`) are index-backed and **newest first**.
  They answer in one page; use `limit`, not paging, to widen them.
- **`_history`** is oldest first and sequence-paged. Follow `next_after` until it is null, and
  keep going even when a page is empty — a page of the log can legitimately contribute nothing.

### Naming conventions

- Object IDs: `<kind>:<slug>` using `[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}`. Examples:
  `repo:checkout`, `service:checkout`, `pipeline:checkout-ingest`, `dataset:checkout_events`,
  `dashboard:checkout-health`, `release:v42`.
- Personal deployments prefix IDs with the owner prefix automatically; use the IDs exactly as they
  appear in the injected block and in tool results.
- Decision record IDs: short kebab-case verbs, `restore-timeout`, `build-ingest-pipeline`, one per
  independent choice. Never the session ID.
- Fact predicates: `snake_case` nouns, `timeout_baseline_ms`, `failure_rate_pct`, `root_cause`.
- Session IDs are assigned by `session_open` and shown in the injected block. Never invent one.

### Provenance is stored, not asserted

- `actor_id` is attribution, not an ACL. Access comes from the caller's collection grants.
- Every mutation needs a stable `idempotency_key`; retry with the same key and body.
- References may precede their targets: cite a dataset version before the table exists.
- Retractions point at what they retract and keep the original attribution. Disagreement is a new
  assertion, not an edit.
- Bodies are at most 32 KiB. Large data stays in the lake; reference it.

### ALWAYS contract (what the hooks do without asking)

Modeled on Agno `LearningMode.ALWAYS`: capture runs on every turn, not when the agent feels like it.

- **SessionStart / prompt**: `session_open` creates or resumes the session object, provisions the
  caller's personal collection on first use, ensures the project object, links them, and returns
  the projected block. Later turns re-project with `session_project`.
- **Tool calls**: consequential Lakeday calls, errors, code edits, and git mutations are tracked.
  `deploy_pipeline`, `run_pipeline`, `create_dashboard`, and `set_table_policy` create objects and
  lineage links server-side — pass `session_id` and `project_entity`.
- **Stop**: if the turn changed anything and no decision was recorded, the stop is blocked once
  with the exact call to make.
- **PreCompact**: nothing depends on the transcript surviving; the next prompt re-projects from
  durable events.

What the model still owns (the AGENTIC layer): the content of decisions, outcomes, facts, and
links. See `lakeday-record`.

One implementation, three surfaces: the SDK module `@lakeday-org/worker-js/learning` is what
`defineAgent({ learning: "always" })` uses inside Lakeday's V8 agents, what the MCP server's
`session_project` and provenance use, and what these hooks import directly.

### Related Skills

- `lakeday-record` for when and how to write decisions, outcomes, facts, and links.
- `lakeday-recall` for reading an object's history before acting.
- `lakeday-query` for SQL over the managed Lance tables.
