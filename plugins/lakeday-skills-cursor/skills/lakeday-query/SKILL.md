---
name: lakeday-query
description: Run read-only DataFusion SQL against Lakeday's managed Lance tables and the lk_knowledge projection with query_sql, including snapshot comparisons and parameterized queries.
license: MIT
---

## Query Lakeday

### Source Of Truth

- `query_describe` is the authoritative table list for the caller right now; it is rebuilt from
  live collection grants on every call.
- The dialect is Apache DataFusion SQL. See `references/DATAFUSION_SQL.md` for the subset that
  matters and the differences from Postgres and DuckDB.
- Docs: https://docs.lakeday.ai/docs/built-ins/query.

### Default Posture

- Read-only. `query_sql` cannot write; ingestion goes through streams, pipelines, and sinks.
- Always bound results: `LIMIT` in SQL and `limit` in the call. The MCP gateway returns at most
  3 MiB; oversize responses are errors, not truncated rows.
- Use parameters (`$1`, positional array, or `:name` with an object) instead of interpolating
  user-supplied values.
- Aggregate in SQL, not in the model. Return the rows that answer the question, not raw data.
- Every result carries the table's snapshot version. Quote it in findings and in decision evidence as
  `{ "kind": "dataset", "id": "<table>", "version": "<snapshot>" }`.
- Compare snapshots explicitly when the question is "what changed": pass `as_of` (or the snapshot
  returned by `run_pipeline`) so a before/after comparison reads two pinned versions.
- Row policies (`row_user_column`) apply before joins and aggregates; a "missing" row may be one
  the caller cannot see.

### Workflow

1. `query_describe` → confirm the table and columns exist.
2. Draft the query with an explicit column list, a `WHERE`, and a `LIMIT`.
3. Run `query_sql` with `tenant_id`, `sql`, optional `params`, and `limit`.
4. Sanity-check: row count, nulls, and whether a `GROUP BY` covers every non-aggregated column.
5. Record what matters: a finding is a fact on the subject entity (`entity_fact`) with the query and
   snapshot as evidence; a measured result of an earlier decision is `session_outcome`.

### Patterns

```sql
-- Failure rate by release and timeout (the checkout investigation)
SELECT release, timeout_ms,
       count(*)                         AS checkouts,
       round(100.0 * avg(CASE WHEN failed THEN 1 ELSE 0 END), 1) AS failure_rate_pct
FROM checkout_events
GROUP BY release, timeout_ms
ORDER BY failure_rate_pct DESC
LIMIT 20;

-- Decisions and their outcomes about one entity
SELECT d.session_id, d.decision_id, d.label AS choice, o.label AS outcome, d.timestamp
FROM lk_knowledge d
LEFT JOIN lk_knowledge o
  ON o.type = 'decision.outcome' AND o.row_kind = 'event'
 AND o.session_id = d.session_id AND o.decision_id = d.decision_id
WHERE d.type = 'decision.recorded' AND d.row_kind = 'reference'
  AND d.target_kind = 'entity' AND d.target_id = $1
ORDER BY d.timestamp DESC LIMIT 20;
```

`lk_knowledge` columns: `row_kind` (`event` | `reference`), `object_kind`, `object_id`,
`sequence`, `type`, `timestamp`, `actor_id`, `session_id`, `decision_id`, `predicate`,
`target_kind`, `target_id`, `target_version`, `target_session_id`, `record_id`, `label`, `detail`,
`payload` (JSON). Assertions and retractions are both events; filter out retracted IDs to get the
current view.

### Related Skills

- `lakeday-explore` to find tables first.
- `lakeday-recall` for the standard knowledge queries.
- `lakeday-dashboard` when the result should become a view for people.
- `lakeday-record` for turning findings into facts, decisions, and outcomes.
