# DataFusion SQL for Lakeday

Lakeday's Query Worker runs Apache DataFusion over managed Lance tables. This is the subset that
matters for agents and the places where habits from Postgres or DuckDB break.

## Identifiers and types

- Unquoted identifiers are case-insensitive and folded to lowercase; double-quote to preserve case.
- Booleans are real booleans: `WHERE failed` works; `WHERE failed = 1` does not.
- Timestamps: `TIMESTAMP` columns compare with literals like `'2026-05-12T10:15:00Z'`; use
  `date_trunc('minute', ts)`, `date_bin(INTERVAL '5 minutes', ts, TIMESTAMP '1970-01-01')` for buckets.
- Casting: `CAST(x AS DOUBLE)`, `x::DOUBLE`, `arrow_cast(x, 'Int64')` for exact Arrow types.
- JSON payloads in `lk_knowledge.payload` are strings; extract with
  `json_get_str(payload, 'choice')` where JSON functions are enabled, otherwise use `label` and
  `detail`, which are pre-extracted for that purpose.

## Aggregates and windows

- `count(*)`, `count(DISTINCT x)`, `avg`, `sum`, `min`, `max`, `approx_percentile_cont(x, 0.95)`,
  `array_agg(x)`, `first_value`, `last_value`.
- Window functions: `row_number() OVER (PARTITION BY k ORDER BY ts)`, `lag`, `lead`, `sum(...) OVER (...)`.
- `round(x, 1)`, `coalesce`, `nullif`, `CASE WHEN`.
- Percentages: `round(100.0 * avg(CASE WHEN failed THEN 1 ELSE 0 END), 1)`.

## Arrays and vectors

- `array_distance(a, b)` for embedding similarity when a table stores vectors.
- `unnest(arr)` in `FROM` to explode arrays; `array_length`, `array_has`, `array_element`.

## Joins and CTEs

- Standard `JOIN ... ON`, `LEFT JOIN`, `WITH cte AS (...)`. Only tables the caller can read are
  registered, so an ungranted table fails to resolve even inside a CTE or subquery.
- `EXCEPT`/`INTERSECT`/`UNION [ALL]` are supported.

## Not supported or different

- No DDL or DML. No `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `COPY`.
- No `ILIKE` guarantees across versions; use `lower(x) LIKE lower($1)`.
- No `QUALIFY`; wrap the window in a subquery.
- `LIMIT` is required in practice; the caller's `limit` argument caps rows regardless.
- One query, one read snapshot. Multiple queries in one dashboard evaluation are not a
  transaction; put aggregates that must agree in one statement.

## Snapshot comparison

Every result reports the table snapshot it read. To compare two versions:

```sql
-- Pin the baseline snapshot with as_of, run once per snapshot, and diff in the model
SELECT release, timeout_ms, count(*) AS checkouts,
       round(100.0 * avg(CASE WHEN failed THEN 1 ELSE 0 END), 1) AS failure_rate_pct
FROM checkout_events
GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 50;
```

Call `query_sql` twice: once with `as_of: "<snapshot before>"` and once with the current snapshot.
Cite both versions in the outcome evidence.

## Knowledge projection cheatsheet

```sql
-- Active facts about an entity (drop retracted ids)
SELECT a.record_id, a.predicate, a.label AS value, a.timestamp
FROM lk_knowledge a
WHERE a.type = 'fact.asserted' AND a.row_kind = 'event' AND a.object_id = $1
  AND NOT EXISTS (
    SELECT 1 FROM lk_knowledge r
    WHERE r.type = 'fact.retracted' AND r.object_id = a.object_id AND r.record_id = a.record_id
      AND r.sequence > a.sequence)
ORDER BY a.timestamp DESC LIMIT 50;

-- Incoming relationships
SELECT object_id, predicate, session_id FROM lk_knowledge
WHERE type = 'relationship.asserted' AND row_kind = 'event' AND target_id = $1 LIMIT 100;

-- Session timeline
SELECT sequence, type, label, timestamp FROM lk_knowledge
WHERE object_kind = 'session' AND object_id = $1 AND row_kind = 'event'
ORDER BY sequence LIMIT 200;
```
