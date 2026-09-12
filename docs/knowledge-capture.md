# Knowledge capture: ALWAYS mode and the Tardigrade projection

This document explains how the hooks in `hooks/` turn every coding-agent session into Lakeday
knowledge, and why the design follows Agno's learning machines and Tardigrade's actor model.

## The problem

An agent that only remembers within a transcript forgets every decision when the window
compacts or the session ends. Lakeday already stores Sessions, Entities, decisions, and outcomes
as durable, attributed, queryable events. What was missing is the forcing function: nothing made
the agent write, and nothing rebuilt its context from what was written.

## Two layers

### ALWAYS (hooks, deterministic, no model in the loop)

Agno's `LearningMode.ALWAYS` runs extraction on every run regardless of what the agent chooses.
The hooks do the same with the harness lifecycle:

| Harness event | Lakeday effect |
| --- | --- |
| `SessionStart` | Resolve the user Entity (`/v1/os/.../entities/me`), create the Session (`<prefix><harness>-<project>-<id>`), ensure the project Entity, link project → session, inject the projection |
| `UserPromptSubmit` | Append `user.prompt`; inject the projection |
| `PostToolUse` | Append `tool.result` for consequential calls, errors, code edits, git mutations; derive dataset evidence; run the provenance plan (`deploy_pipeline`, `stream_load`, `create_dashboard`, `set_table_policy` → entities and `reads_from` / `writes_to` / `produced_by` / `loaded_from` / `owns` links); count the model's own `session_decide` / `session_outcome` / `entity_fact` calls |
| `Stop` | If the turn had consequential effects and no decision, block once with the exact `session_decide` call. Otherwise append `assistant.turn` and replace the Session context (goal, decisions, datasets, open errors) |
| `PreCompact` | Replace the Session context before the harness compacts (the compaction boundary is an event) |
| `SessionEnd` | Append `session.ended` |

Enforcement is bounded: one block per turn by default (`max_stop_blocks_per_turn`), honoring
`stop_hook_active` on Claude/Codex and `loop_count` on Cursor. The block reason tells the model to say
"nothing consequential happened" if that is true; the hook does not block again.

Everything is fail-open. No credential, no tenant, a 5xx, or a timeout means the hook exits 0 with
no output and the coding agent proceeds.

### AGENTIC (skills, the model chooses content)

The hooks never invent a rationale. The `lakeday-record` skill tells the model what a decision,
outcome, fact, and link should contain; the `lakeday-recall` skill tells it to look first. The MCP
tools are the write path. Agno's `PROPOSE` mode maps to the block message: the hook proposes the
write, the model fills it in.

## Projection (Tardigrade)

Tardigrade components have `initial`, `reduce(state, event)`, and `view(state)`. Lakeday's V8
agent harness already projects components from immutable events before inference. The hooks apply
the same idea to external harnesses, using the Session DO history as the event log:

- `goal` — from `session.created`
- `context` — the latest `session.context` (replace semantics)
- `decisions` — `decision.recorded` + `decision.outcome`, showing which are unmeasured
- `datasets` — dataset/url references from evidence and links, with versions
- `uncertain` — tool errors not followed by a later success of the same tool
- `recent` — the last few events
- `facts` — active facts on the project Entity (asserted minus retracted)
- `prior decisions` — the project object's own `/decisions`, read newest first

`renderContext()` concatenates views into a `<lakeday-knowledge>` block under a character budget
(default 16,000), dropping trailing sections first. The block is injected as `additionalContext`
(Claude, Codex) or `additional_context` (Cursor). Because it is rebuilt every turn from Lakeday,
compaction cannot lose it and a new session in the same project starts with the prior decisions
and outcomes.

## Naming

- Session: `<owner prefix><harness>-<project>-<12 chars of harness session id>`
- Project entity: `<owner prefix>repo-<slug>` (personal) or `repo:<slug>` (`shared_entities: true`)
- Provenance entities: `pipeline:<name>`, `dataset:<stream|table|external uri>`, `dashboard:<name>`,
  `worker:<name>`, prefixed the same way

## Configuration

`.lakeday/agent-skills.json` (project) or `~/.lakeday/agent-skills.json` (user):

```json
{
  "tenant_id": "acme-analytics-org01abc",
  "project": "checkout",
  "project_entity": "repo:checkout",
  "shared_entities": false,
  "enforce_decisions": true,
  "max_stop_blocks_per_turn": 1,
  "context_budget_chars": 16000,
  "recall_prior_decisions": true
}
```

The hooks hold no credential and make no network calls. The model opens and re-projects the
session through `session_open` / `session_project` under the MCP client's OAuth sign-in, and the
hook only injects that instruction, keeps a local ledger, and blocks the stop. Environment:
`LAKEDAY_TENANT_ID`, `LAKEDAY_HOOKS=0`, `LAKEDAY_HOME`, `LAKEDAY_HOOK_DEBUG=1`,
`LAKEDAY_HOOK_HARNESS=claude|codex|cursor` (override detection).

## One implementation, three surfaces

The projection, tool classification, provenance plan, and ALWAYS verdict live in the Lakeday
SDK as `@lakeday-org/worker-js/learning` (`sdk/packages/worker-js/src/learning.js`). Three
consumers share it:

| Surface | One-liner | What it does with the module |
| --- | --- | --- |
| Lakeday V8 agents | `defineAgent({ learning: "always" })` | Appends the knowledge tools, folds Session history into working memory, renders a ledger component, and sends a finishing run back once via a `lakeday.learning.required` event |
| MCP server | `session_project` tool | Folds history, facts, and prior decisions server-side for any client; `deploy_pipeline`, `run_pipeline`, `create_dashboard`, `set_table_policy` record provenance |
| Coding-agent hooks (this repo) | `node scripts/install-hooks.mjs --agent claude` | Harness adapters import the published `@lakeday-org/worker-js/learning`; `npm run build` bundles that dependency into each distributed plugin hook |

The source hook has a runtime dependency on the published SDK. Distributed plugin hooks are
bundled with esbuild, so a fresh plugin install can execute without a post-install dependency
fetch or a machine-local source checkout.

## Product assumptions

Implemented in the Lakeday monorepo alongside this repository: `run_pipeline` (returns
`table_version` from the sink), `session_project`, server-side provenance with `session_id` /
`project_entity` inputs, the learning one-liner for V8 agents, and the removal of the 100-row
caps on the default agent's `query_sql` and `lake_ingest`.

Still assumed:

- A foreign-source ingestion built-in (`stream_load`, or an `ingest` Worker with `POST /load`) reads
  `s3://`, `https://`, and presigned URIs in JSONL/CSV/Parquet into a stream and stamps the source URI.
- `query_sql` accepts `as_of` and reports the snapshot it read.
