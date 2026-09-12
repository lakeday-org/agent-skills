# DataFusion SQL for Lakeday

Lakeday's Query Worker runs Apache DataFusion over managed Lance tables. This is the subset that
matters for agents and the places where habits from Postgres or DuckDB break.

## Identifiers and types

- Unquoted identifiers are case-insensitive and folded to lowercase; double-quote to preserve case.
- Booleans are real booleans: `WHERE failed` works; `WHERE failed = 1` does not.
- Timestamps: `TIMESTAMP` columns compare with literals like `'2026-05-12T10:15:00Z'`; use
  `date_trunc('minute', ts)`, `date_bin(INTERVAL '5 minutes', ts, TIMESTAMP '1970-01-01')` for buckets.
- Casting: `CAST(x AS DOUBLE)`, `x::DOUBLE`, `arrow_cast(x, 'Int64')` for exact Arrow types.
- JSON stored in a string column is text; extract with `json_get_str(col, 'field')` where JSON
  functions are enabled.

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

## Knowledge is not queried in SQL

Decisions, outcomes, facts, and links live in each object's own event history, not in a shared
table. Read them with `entity_decisions`, `entity_outcomes`, `entity_facts`, `entity_links`,
`entity_refs`, and `entity_history` — see `lakeday-recall`. `query_sql` reads the Lance tables
those records are *about*: the measurements an outcome cites, the data a pipeline produced.
