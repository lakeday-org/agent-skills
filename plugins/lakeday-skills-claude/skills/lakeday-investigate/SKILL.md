---
name: lakeday-investigate
description: End-to-end incident or regression investigation on Lakeday — ingest the evidence, compare against a baseline, recall prior decisions, publish a dashboard, record the decision, and verify the outcome.
license: MIT
---

## Investigate a regression

Use this for "why did X jump?", "what changed when Y started?", and "did the fix work?" when the
evidence is in a file, bucket, stream, or existing table.

### Source Of Truth

- Data: `query_describe`, `query_sql` with snapshot versions.
- History: `entity_decisions`, `session_outcomes`, and the injected `<lakeday-knowledge>` block.
- Everything else in this skill composes `lakeday-ingest`, `lakeday-query`, `lakeday-recall`,
  `lakeday-dashboard`, `lakeday-access`, and `lakeday-record`.

### Default Posture

- Start a named session goal. The hooks create the session; state the goal in your first reply so
  it lands in the context (`session_context` if you want it pinned).
- Bring evidence into the lake before analyzing it. Model-side analysis of a preview is a guess;
  the table is the record.
- Keep a link to the source: source key column, `dataset:<source uri>` entity, `loaded_from` link,
  and the URL in evidence.
- Compare against a baseline, not against intuition: previous release, previous window, or the
  prior incident's measured outcome.
- Recall before deciding. If a prior decision covers the same subject, cite it and either reuse or
  explicitly reject it in `alternatives`.
- One decision, one outcome, one dashboard revision per change. Verify with the same query at the
  new snapshot.

### Workflow (the checkout playbook)

1. **Frame**: identify subjects (`service:checkout`, `release:v42`, `dataset:checkout_events`). Ask
   for the source location if not given.
2. **Recall** (`lakeday-recall`): `entity_decisions("service:checkout")`, outcomes of the most
   relevant one. Note baselines from `entity_facts`.
3. **Ingest** (`lakeday-ingest`): preview the source; `assign_data_source`; `deploy_pipeline
   checkout-ingest` (transform keeps `event_id`); `stream_load` from the S3 URI; `run_pipeline` →
   note the snapshot (e.g. 42).
4. **Compare** (`lakeday-query`):
   ```sql
   SELECT release, timeout_ms, count(*) AS checkouts,
          round(100.0 * avg(CASE WHEN failed THEN 1 ELSE 0 END), 1) AS failure_rate_pct
   FROM checkout_events GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 20;
   ```
   State the finding with numbers and the snapshot: "v42 (200 ms) 8.4% vs v41 (1,200 ms) 0.6%,
   snapshot 42". Write it as `entity_fact` on `release:v42` (`predicate: "changed"`) and
   `service:checkout` (`predicate: "failure_rate_pct"`).
5. **Show** (`lakeday-dashboard`): `ui_catalog` → JSX with a Metric, a BarChart by release, and a
   window filter → `validate_ui` → `create_dashboard checkout-health` → `set_table_policy` +
   `collection_grant` → `inspect_dashboard` (the 8.4% must match step 4) → `render_dashboard`.
6. **Decide** (`lakeday-record`): `session_decide restore-timeout` with subjects, rationale, the
   rejected alternatives (more retries, full rollback), and evidence (dataset@42, prior decision,
   release notes URL).
7. **Verify**: after the change ships, `stream_load` the new window, `run_pipeline` → snapshot 43,
   re-run the comparison at both snapshots, `session_outcome restore-timeout` with the measured
   result, `update_dashboard` with the restored-timeout window, `inspect_dashboard` against
   snapshot 43, `render_dashboard`.
8. **Close**: one paragraph for the human: what changed, what you did, what the numbers say now,
   with the dashboard link. The next session's projection will carry the decision and outcome.

### Related Skills

- `lakeday-ingest`, `lakeday-query`, `lakeday-recall`, `lakeday-dashboard`, `lakeday-access`,
  `lakeday-record`, `lakeday-web` (release notes and external incident reports).
