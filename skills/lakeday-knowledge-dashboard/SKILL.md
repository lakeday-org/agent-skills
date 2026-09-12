---
name: lakeday-knowledge-dashboard
description: Publish a human-facing view of an investigation — evidence, decision, outcome — by reading the subject object's own history and publishing it alongside the source tables in a JSX2UI dashboard.
license: MIT
---

## Show people the evidence and the decision

The same knowledge the agent reads can power a view for the team: follow a claim to its query and
source data, inspect the choice and its alternatives, and see what happened next.

### Source Of Truth

- The subject object's own history — `entity_decisions`, `entity_outcomes`, `entity_facts`,
  `entity_links` — for the narrative; the source tables for the numbers.
- `ui_catalog` for components. See `lakeday-dashboard` for the authoring loop.

### Default Posture

- Three panels, in this order: **Evidence** (the chart and the query that produced it, with the
  snapshot), **Decision** (choice, rationale, alternatives, who chose, when), **Outcome** (the
  measured result at the later snapshot, linked to the decision).
- Every number on the page must be reproducible by a query the viewer can run. Put the SQL in a
  `Text` component under the chart.
- Dashboards read SQL, and knowledge lives in object histories rather than in a table. So the
  narrative panels are **published deliberately**: read the records, write the ones you want to
  show into a small table you own, and point the dashboard at that. This is an explicit, scoped
  snapshot of one investigation with its own provenance — not a standing mirror of every write.
- Viewers need grants on both that table's collection and the source table's collection.
- Keep it to one investigation per dashboard; use a `Select` if several must share a page.

### Workflow

1. Read the narrative off the subject object:
   - `entity_decisions(tenant_id, id=<subject>, limit=20)` → choice, rationale, alternatives,
     `actor_id`, timestamp, record ID.
   - `entity_outcomes(tenant_id, id=<subject>, record_id=<decision>)` → the measured result.
   - Each decision's `evidence` already names the datasets and versions it cites.
2. Publish those rows into a table you own (one row per decision, one per outcome), then
   `set_table_policy` with a `sql_alias` such as `checkout_review` and `session_id` so the table
   is recorded as a dataset object with lineage back to this session.
3. Write the source query from the investigation (for example failure rate by release) against the
   original Lance tables. That panel needs no publishing step.
4. JSX: `Dashboard` → `Grid` with a `Card` per panel; `LineChart`/`BarChart` for evidence,
   `DataTable` for the decision and outcome rows, `Text` for the SQL.
5. `validate_ui` → `create_dashboard <subject>-review` (pass `session_id` and `project_entity`) →
   grants → `inspect_dashboard` → `render_dashboard`.
6. Link it so the dashboard is discoverable from the subject:
   `entity_link(id="dashboard:<name>", data={ id: "reviews-<subject>", actor_id: "<actor>", predicate: "reviews", about: "<subject id>" })`.
7. Record the publication with `entity_decide` on the dashboard object.

### Related Skills

- `lakeday-dashboard` for the authoring and publishing loop.
- `lakeday-access` for grants on the published and source collections.
- `lakeday-recall` for reading the decisions and outcomes to show.
