---
name: lakeday-knowledge-dashboard
description: Publish a human-facing view of an investigation — evidence, decision, outcome — by joining lk_knowledge with the source tables in a JSX2UI dashboard.
license: MIT
---

## Show people the evidence and the decision

The same knowledge the agent queries can power a view for the team: follow a claim to its query and
source data, inspect the choice and its alternatives, and see what happened next.

### Source Of Truth

- `lk_knowledge` for decisions, outcomes, facts, and references; the source tables for the numbers.
- `ui_catalog` for components. See `lakeday-dashboard` for the authoring loop.

### Default Posture

- Three panels, in this order: **Evidence** (the chart and the query that produced it, with the
  snapshot), **Decision** (choice, rationale, alternatives, who chose, when), **Outcome** (the
  measured result at the later snapshot, linked to the decision).
- Every number on the page must be reproducible by a query the viewer can run. Put the SQL in a
  `Text` component under the chart.
- Viewers need grants on both the knowledge collection and the source table's collection.
- Keep it to one investigation per dashboard; use a `Select` on `session_id` if several must share a page.

### Workflow

1. Queries:
   ```sql
   -- Decision panel
   SELECT decision_id, label AS choice, detail AS rationale, actor_id, timestamp
   FROM lk_knowledge
   WHERE type = 'decision.recorded' AND row_kind = 'event' AND session_id = $1
   ORDER BY sequence LIMIT 10;

   -- Outcome panel
   SELECT decision_id, label AS outcome, timestamp
   FROM lk_knowledge
   WHERE type = 'decision.outcome' AND row_kind = 'event' AND session_id = $1
   ORDER BY sequence LIMIT 10;

   -- Evidence references (datasets and versions the decision cites)
   SELECT decision_id, target_kind, target_id, target_version
   FROM lk_knowledge
   WHERE row_kind = 'reference' AND session_id = $1 AND decision_id IS NOT NULL LIMIT 50;
   ```
   plus the source query from the investigation (for example failure rate by release).
2. JSX: `Dashboard` → `Grid` with a `Card` per panel; `LineChart`/`BarChart` for evidence,
   `DataTable` for decision and outcome rows, `Text` for the SQL. Bind `session_id` to a `Select`
   state with the sessions from `entity_sessions(<subject>)`.
3. `validate_ui` → `create_dashboard <subject>-review` → grants → `inspect_dashboard` →
   `render_dashboard`.
4. Link it: `entity_link(id="dashboard:<name>", predicate="reviews", target={kind:"session", id: <session>})`.
5. Record the publication as a decision with the dashboard as subject.

### Related Skills

- `lakeday-dashboard` for the authoring and publishing loop.
- `lakeday-access` for grants on the knowledge and source collections.
- `lakeday-recall` for the queries that find the sessions and decisions to show.
