---
name: lakeday-explore
description: Discover what a Lakeday deployment already holds — Workers, pipelines, collections, Lance tables, dashboards, and the object graph — before building anything.
license: MIT
---

## Explore a Lakeday deployment

### Source Of Truth

- Live tools beat memory. The deployment's state is `list_workers`, `list_pipelines`,
  `list_collections`, `collection_tables`, `query_describe`, and `list_dashboards`.
- The MCP resources `lakeday://me`, `lakeday://deployments/{tenant_id}/workers`, `/endpoints`,
  and `/tables` return the same data for clients that browse before acting.
- Knowledge lives in each object's own history, not in SQL: `entity_get`, `entity_links`,
  `entity_decisions`, `entity_facts`. Start from the project object in the injected block.

### Default Posture

- Explore before creating. Most investigations reuse an existing stream, table, or dashboard.
- Read the schema with `query_describe`, then sample with `query_sql ... LIMIT 20`. Never scan a
  table without a `LIMIT` or `limit`.
- Table visibility follows the caller's collection grants. An absent table is usually a missing
  grant, not a missing table; check `list_collections` for permissions.
- Do not narrate every listing. Summarize the parts relevant to the task and keep identifiers exact.

### Workflow

1. `list_deployments` → pick `tenant_id`.
2. `list_collections` → note which collections the caller can read, write, or manage.
3. `query_describe` → tables, columns, and types the Query Worker can read right now.
4. `collection_tables` for the relevant collection → SQL aliases and row policies.
5. `list_workers` and `list_pipelines` → existing ingestion and transforms (`<name>-transform`,
   `<name>-sink`).
6. `list_dashboards` → views already published for these tables.
7. Knowledge: run the recall queries in `lakeday-recall` to find prior sessions and decisions
   about the subject before proposing new work.
8. Report a compact inventory: data sources, tables (row estimate from `SELECT count(*)` only when
   cheap), pipelines feeding them, dashboards reading them, and knowledge that references them.

### Following lineage

Provenance is graph edges on the objects themselves, written server-side when you pass
`session_id` and `project_entity` to `deploy_pipeline`, `run_pipeline`, `create_dashboard`, and
`set_table_policy`.

- `entity_links(tenant_id, id="pipeline:<name>")` → `reads_from` its source, `writes_to` its table.
- `entity_links(tenant_id, id="dataset:<table>")` → `produced_by` the pipeline that wrote it.
- `entity_links(tenant_id, id=<project object>)` → the pipelines and dashboards it `owns`.
- `entity_refs(tenant_id, id=<object>, object=<other>, kind="link")` → the edge between two
  specific things.

Sample the data itself with `query_describe` and `query_sql`; see `lakeday-query`.

### Related Skills

- `lakeday-query` for DataFusion SQL details and result limits.
- `lakeday-access` when a table or object is not visible.
- `lakeday-recall` for prior decisions and outcomes about a subject.
- `lakeday-ingest` when the data is not in Lakeday yet.
