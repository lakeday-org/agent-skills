---
name: lakeday-workers
description: Author, deploy, invoke, and inspect Lakeday Workers and Durable Objects with explicit bindings through deploy_worker, invoke_worker, and get_worker.
license: MIT
---

## Build and deploy Workers

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/get-started/quickstart,
  https://docs.lakeday.ai/docs/built-ins/durable-objects,
  https://docs.lakeday.ai/docs/concepts/platform.
- `get_worker` shows the live deployment: artifact digest, triggers, resources, scope.

### Default Posture

- A Worker is a stateless `fetch` / `scheduled` handler in a V8 isolate. State lives in Durable
  Objects (KV, SQL, alarms, WebSockets; Lance-backed), Streams, or Sinks.
- Declare every capability in the manifest; missing bindings fail closed. Bindings grant
  capability, not data access: managed storage also checks the caller's collection grants.
- `deploy_worker` takes one bundled ES module: it uploads an immutable version, then activates
  that digest. Bundle multi-file projects with your bundler first (esbuild, format esm, platform
  browser); do not paste several files into the tool.
- Prefer the smallest component: Worker → own DO → Stream → Transform → Sink → Query.
- `env.RUNTIME.spawn()` moves a granted Worker stack onto its own Machine in the same tenant app.
  Use it for heavy pipelines, not for isolation of users.

### Workflow

1. Write a single ES module for `deploy_worker`.
2. Manifest bindings (JSON in the project config):
   ```json
   {
     "services": [
       { "binding": "QUERY", "service": "query" },
       { "binding": "ENTITY", "service": "entity" },
       { "binding": "SESSION", "service": "session" },
       { "binding": "JSX2UI", "service": "jsx2ui" }
     ],
     "pipelines": [{ "binding": "EVENTS", "stream": "checkout-events" }],
     "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] }
   }
   ```
3. Code against the bindings:
   ```js
   export default {
     async fetch(request, env) {
       await env.EVENTS.send([{ id: crypto.randomUUID(), kind: "signup" }]);
       const res = await env.QUERY.fetch("https://query.internal/run", {
         method: "POST", headers: { "content-type": "application/json" },
         body: JSON.stringify({ sql: "SELECT count(*) AS n FROM checkout_events" }),
       });
       return Response.json(await res.json());
     },
     async scheduled(_event, env) { /* needs SERVICE_IDENTITY_TOKEN for data access */ },
   };
   ```
4. Deploy: `deploy_worker(tenant_id, worker, source, durable?, public?, crons?, dependencies?)`.
5. Smoke: `invoke_worker(tenant_id, worker, path="/", method="GET")`; `get_worker` for state and triggers.
6. Secrets go through the Worker secrets API (`PUT /v1/deployments/:id/workers/:worker/secrets`
   via `product_api` or the dashboard); scheduled data access needs `SERVICE_IDENTITY_TOKEN`.
7. Record the deployment decision with `entity_decide` on `worker:<name>` (the hooks create the object when
   you deploy through MCP).

### Durable Objects

- Named objects: `env.NAME.get(id)` / `getByName(name)` then `.fetch(...)`; one object is one
  serialized actor.
- `storage.lance` backs application vector or graph behavior; `env.publish(rows)` publishes a
  derived index for SQL.
- Alarms and WebSockets hibernate; protected sockets require namespace write authority at connect.

### Related Skills

- `lakeday-ingest` when the Worker produces events for a pipeline.
- `lakeday-access` for Worker scope and collection grants.
- `lakeday-dashboard` to publish a view Worker from JSX.
