---
name: lakeday-explore
description: Discover what a Lakeday deployment already holds — Workers, pipelines, collections, Lance tables, dashboards, and the lk_knowledge graph — before building anything.
license: MIT
---

## Explore a Lakeday deployment

### Source Of Truth

- Live tools beat memory. The deployment's state is `list_workers`, `list_pipelines`,
  `list_collections`, `collection_tables`, `query_describe`, and `list_dashboards`.
- The MCP resources `lakeday://me`, `lakeday://deployments/{tenant_id}/workers`, `/endpoints`,
  and `/tables` return the same data for clients that browse before acting.
- Knowledge (entities, sessions, decisions, outcomes) is queryable SQL in `lk_knowledge`.

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

### Useful SQL

```sql
-- Tables referenced by evidence in decisions (dataset lineage from the knowledge side)
SELECT target_id AS dataset, target_version, count(*) AS references
FROM lk_knowledge
WHERE row_kind = 'reference' AND target_kind = 'dataset'
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50;

-- Pipelines and the tables they write, from provenance links the hooks record
SELECT object_id AS pipeline, target_id AS table_entity, session_id
FROM lk_knowledge
WHERE type = 'relationship.asserted' AND predicate = 'writes_to' LIMIT 100;
```

### Related Skills

- `lakeday-query` for DataFusion SQL details and result limits.
- `lakeday-access` when a table or object is not visible.
- `lakeday-recall` for prior decisions and outcomes about a subject.
- `lakeday-ingest` when the data is not in Lakeday yet.
