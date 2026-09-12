---
name: lakeday-query
description: Run read-only DataFusion SQL against Lakeday's managed Lance tables with query_sql, including snapshot comparisons and parameterized queries.
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

-- Failure rate by release, compared across two table versions
SELECT release,
       count(*) FILTER (WHERE failed) AS failures,
       count(*)                       AS total
FROM checkout_events
GROUP BY release
ORDER BY failures DESC
LIMIT 20;
```

Knowledge is not in SQL. Decisions, outcomes, facts, and links live in each object's own
history and are read with `entity_decisions`, `entity_outcomes`, `entity_facts`, and
`entity_links` — see `lakeday-recall`. `query_sql` reads the data those records are *about*.

### Related Skills

- `lakeday-explore` to find tables first.
- `lakeday-recall` for reading decisions, facts, and links off an object.
- `lakeday-dashboard` when the result should become a view for people.
- `lakeday-record` for turning findings into facts, decisions, and outcomes.
