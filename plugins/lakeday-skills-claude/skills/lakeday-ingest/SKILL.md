---
name: lakeday-ingest
description: Bring a foreign dataset (S3, HTTP, files, webhooks) into Lakeday as a stream, pipeline, and Lance table with provenance back to the source, then run it with run_pipeline.
license: MIT
---

## Ingest data into Lakeday

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/built-ins/streams-pipelines and
  https://docs.lakeday.ai/docs/recipes/webhook-to-lakehouse.
- `deploy_pipeline` compiles the graph; the transform contract is in `references/TRANSFORM_AUTHORING.md`.
- Check `list_pipelines` and `query_describe` first; the table may already exist.

### Default Posture

- The model is Stream → Transform → Sink. A Stream is a durable ordered JSON queue; a Transform is
  a Worker whose output and input checkpoint commit in one Lance event; the Sink appends rows to a
  managed Lance table with exactly-once semantics.
- Load foreign data with the ingestion built-in, not by pushing rows through the model.
  `stream_load` (or the `ingest` Worker's `POST /load`) reads a source URI (`s3://`, `https://`,
  presigned URLs, JSONL, CSV, Parquet) into a named stream and records the source URI, ETag,
  and row count. Reserve `stream_send` for small event batches produced by your own code.
- Keep the source ID column. The transform must pass through the original record key
  (`event_id`, `id`, or a hash of the row) so findings can be traced back to the source file.
- Assign the stream's source to a collection **before** the first write; a source can never be
  rebound.
- Name things so lineage reads naturally: stream `checkout-events`, pipeline `checkout-ingest`,
  transform Worker `checkout-ingest-transform`, sink table `checkout_events`.
- Credentials for private sources are Worker secrets, never tool arguments.

### Workflow

1. Inspect the source. For S3/HTTP, fetch a bounded preview (first rows, field names, row count
   estimate). Note the schema and the natural key.
2. Plan the target: stream name, output stream, sink table, collection, cron (if recurring).
3. Governance first: `list_collections`; if needed `create_collection`; then
   `assign_data_source(collection, worker="system", binding="STREAM", source_name=<stream>)` for both
   the source and output streams.
4. Write the transform: a self-contained ES module that default-exports `async (events) => rows`.
   Normalize types, keep the source key, drop nothing you might need for the comparison.
5. `deploy_pipeline(name, source_stream, transform_module, output_stream, sink_table, cron?, batch_size?,
   session_id, project_entity)`. Pass the session id and project entity from the injected
   `<lakeday-knowledge>` block: the server records `pipeline:<name>`, `dataset:<source>`,
   `dataset:<table>`, and their `reads_from` / `writes_to` / `produced_by` / `owns` links, and
   returns them under `provenance`.
6. Load: `stream_load(stream=<source>, source="s3://bucket/checkout-events.jsonl", format="jsonl")`.
   Confirm the returned row count matches the preview.
7. Run: `run_pipeline(name, max_batches?, session_id)`. It drains the source stream through
   `<name>-transform` and then `<name>-sink`, one bounded batch at a time (default 8 per step),
   and returns `table_version` from the last sink commit. If `drained` is false, call it again.
8. Verify: `query_sql SELECT count(*) FROM <table>` and a 5-row sample. Compare with the source
   count.
9. Record the decision (`session_decide`) with subjects `[pipeline:<name>, dataset:<table>]` and
   evidence `[{kind:"url", id:<source uri>}, {kind:"dataset", id:<table>, version:<snapshot>}]`.
   The Stop hook will insist if you skip this.

### Recurring ingestion

- Pass `cron` to `deploy_pipeline` for scheduled runs; set `SERVICE_IDENTITY_TOKEN` on the
  transform and sink Workers so scheduled executions have a data identity.
- For webhooks, deploy a Worker whose `fetch` calls `env.EVENTS.send(records)`; see the
  webhook recipe.
- Deduplicate in the transform with a deterministic batch ID and a stable row key; see the
  deduplicate-events recipe.

### Related Skills

- `lakeday-access` for collections, source assignment, and grants.
- `lakeday-workers` for authoring the transform as a Worker with bindings.
- `lakeday-query` to verify the table.
- `lakeday-record` for the decision and evidence to write.
