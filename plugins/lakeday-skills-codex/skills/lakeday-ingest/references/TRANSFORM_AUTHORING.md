# Transform authoring

A pipeline transform is a self-contained ES module. `deploy_pipeline` wraps it into
`<name>-transform`.

## Contract

```js
// transform.js — default export: async (events) => rows
export default async function transform(events) {
  const rows = [];
  for (const event of events) {
    const source = event.payload ?? event;           // stream envelope or raw record
    if (source == null || typeof source !== "object") continue;
    rows.push({
      event_id: String(source.event_id ?? source.id ?? hash(source)),   // keep the source key
      release: String(source.release ?? "unknown"),
      timeout_ms: Number(source.timeout_ms ?? source.timeoutMs ?? 0),
      failed: Boolean(source.failed),
      observed_at: source.ts ? new Date(source.ts).toISOString() : null,
      source_file: source.__source ?? null,          // stream_load stamps the source URI when asked
    });
  }
  return rows;
}

function hash(value) {
  let h = 0;
  for (const c of JSON.stringify(value)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}
```

Rules:

- No imports, no Node APIs, no network `fetch`. The module runs in a V8 isolate inside the tenant
  runtime with only the granted bindings.
- Be deterministic. The same input batch must produce the same rows; the Sink commits with the
  transform's deterministic batch ID, and a retry re-runs the same batch.
- Return flat rows with stable column names and consistent types. The first committed batch fixes
  the Lance schema; later type drift fails the commit.
- Keep the source identifier and, when the source stamps it, the source URI. Lineage back to the
  original S3 object is a column, not a comment.
- Drop rows you cannot type; do not throw for one bad record. Count drops in the output if the
  comparison needs them.

## Batch shapes

- `stream_pull` returns `{ events: [{ offset, payload }], from, through }`. The compiled transform
  Worker unwraps `payload` before calling your function; when you call the built-ins by hand
  (`transform_commit`, `sink_commit`), you pass envelopes yourself.
- `batch_size` defaults to 256, maximum 1000. Bigger batches mean fewer Lance commits.

## Manual pipeline (for debugging)

```text
stream_pull   tenant_id stream=checkout-events consumer=debug limit=10
transform_commit tenant_id batch={batch_id, consumer, source_stream, from, through, output_stream, events}
sink_commit   tenant_id batch={batch_id, consumer, source_stream, from, through, table, rows}
sink_read     tenant_id table=checkout_events limit=5
```

Use this only to inspect a stuck batch. Production runs use `run_pipeline` or the cron trigger.
