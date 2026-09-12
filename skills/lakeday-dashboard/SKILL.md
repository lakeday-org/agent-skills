---
name: lakeday-dashboard
description: Author, validate, publish, inspect, and render JSX2UI dashboards over Lakeday tables with ui_catalog, validate_ui, create_dashboard, inspect_dashboard, and render_dashboard.
license: MIT
---

## Build a dashboard

### Source Of Truth

- `ui_catalog` is the only authoritative list of components and props. Read it before writing JSX;
  do not rely on remembered component names.
- Docs: https://docs.lakeday.ai/docs/built-ins/jsx2ui and
  https://docs.lakeday.ai/docs/concepts/mcp#interactive-dashboards-in-chat.

### Default Posture

- A dashboard document is `{ revision, source (JSX), state, queries, refresh? }`. JSX is
  restricted: literals, `s.queries.NAME.rows[i].field`, and `bind(s.state.NAME)`. No imports,
  functions, handlers, or HTML injection. Every component needs a unique literal `id`.
- Queries are named read-only SQL with `limit` (≤ 1000 rows) and `params` bound to state. One
  query per aggregate that must agree; separate queries are not one snapshot.
- The dashboard answers one question. Pick the metric, the comparison, and the filter that make
  the change visible (baseline vs. release, before vs. after).
- Publishing grants no data access. Viewers need collection grants on the tables; see
  `lakeday-access`.
- Bounds: 64 KiB JSX, 16 queries, 32 state fields, 10 s query deadline, 2 MiB results per evaluation.

### Workflow

1. `ui_catalog(tenant_id)` → components (Dashboard, Grid, Stack, Card, Text, Metric, DataTable,
   BarChart, LineChart, Timeline, Select, DateRange, RefreshButton, EmptyState) and their props.
2. Draft the queries with `query_sql` first and confirm the numbers by hand.
3. Write the document:
   ```jsx
   <Dashboard id="root" title="Checkout failures">
     <Stack id="filters" direction="row">
       <Select id="window" label="Observation window" value={bind(s.state.window)} />
     </Stack>
     <Grid id="kpis" columns={2}>
       <Metric id="rate" label="failed checkouts" value={s.queries.rate.rows[0].failure_rate_pct} suffix="%" />
       <Metric id="timeout" label="timeout" value={s.queries.rate.rows[0].timeout_ms} suffix=" ms" />
     </Grid>
     <BarChart id="by_release" data={s.queries.by_release.rows} x="release" y="failure_rate_pct" />
   </Dashboard>
   ```
   with `state: { window: { type: "string", value: "release", options: ["baseline", "release", "restored"] } }`
   and `queries: { rate: { sql: "...", params: { window: { state: "window" } }, limit: 10 }, by_release: {...} }`.
4. `validate_ui(tenant_id, document)` → fix every diagnostic. Validation plans SQL and checks
   bindings; it does not run queries.
5. `create_dashboard(organization_id, deployment_id, name, document, session_id, project_entity)` →
   returns the dashboard `id` and publishes a view Worker. Pass the session id and project entity
   from the injected block; the server records `dashboard:<name>` and a `reads_from` link to every
   table its queries touch, returned under `provenance`.
6. `set_table_policy` + `collection_grant` for the intended viewers (`lakeday-access`).
7. `inspect_dashboard(id, state)` → compare resolved component values against the numbers from
   step 2. Do not render until they match.
8. `render_dashboard(id)` → shows the interactive view in chat (MCP Apps hosts) and returns the
   evaluation for others. Filters and Refresh call `evaluate_dashboard` through the host bridge.
9. `update_dashboard(id, document)` with a bumped `revision` for edits; invalid JSX leaves the
   deployed version unchanged.
10. Record the decision with `entity_decide` on `dashboard:<name>`, evidence citing the table
    snapshot, and link the dashboard to the investigation session.

### Related Skills

- `lakeday-query` for the SQL behind each widget.
- `lakeday-access` for viewer grants.
- `lakeday-knowledge-dashboard` for dashboards that show decisions and outcomes to people.
