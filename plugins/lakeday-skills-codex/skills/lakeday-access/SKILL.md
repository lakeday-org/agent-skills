---
name: lakeday-access
description: Manage Lakeday data collections, source assignment, collection grants, and table row policies so Workers, dashboards, and people can read the right tables — the "grant table" workflow.
license: MIT
---

## Data access and governance

### Source Of Truth

- Docs: https://docs.lakeday.ai/docs/concepts/authorization.
- `list_collections` returns the caller's live permissions; `collection_tables` returns the tables
  and row policies inside one collection.
- Grants live in WorkOS Authorization. The MCP server never adds grants on its own.

### Default Posture

- Two checks protect managed data: permission to invoke the Worker, and permission on the
  source collection. Workspace admin is not data access. Publishing a Worker or dashboard grants
  nothing.
- Collections group sources (Entity, Session, Stream) and the tables they produce. Assign a source
  **before its first storage operation**; it can never be reassigned.
- Roles: `collection-reader`, `collection-writer`, `collection-manager`. Grant to org memberships
  (by `email` or `membership_id`), never to org-wide roles.
- "Let dashboard X read table Y" means two things: register the table in a collection with a SQL
  alias (`set_table_policy`), and grant the intended people that collection (`collection_grant`).
  Dashboards evaluate with the viewer's grants, not their own.
- Row policies (`row_user_column`) restrict rows to the authenticated user's ID; once any table in a
  collection has one, raw source access to that collection is denied and reads go through Query.
- Service identities for scheduled Workers need entrypoint permissions plus `collections:*`.

### Workflow: grant a table

1. `list_collections` → find or create the collection (`create_collection(tenant_id, id, name)`;
   the creator gets the manager grant).
2. `collection_tables(collection)` → confirm the table row exists (tables are registered
   automatically by the Sink that created them and inherit the source's collection).
3. `set_table_policy(collection, table_name, sql_alias, row_user_column?, session_id)` → the alias
   is the name people query; leave `row_user_column` null unless rows are personal. The server
   records `dataset:<table>` as an entity.
4. `collection_grant(collection, email|membership_id, role)` → for each reader.
5. Verify as the reader: `query_describe` with their credential, or ask them to open the dashboard.
6. Record the decision with `entity_decide` on `dataset:<table>`, choice "granted
   <role> on <collection> to <who>", rationale, evidence.

### Workflow: new source

```text
create_collection   tenant_id id=checkout name="Checkout"
assign_data_source  tenant_id collection=checkout worker=system binding=STREAM source_name=checkout-events
assign_data_source  tenant_id collection=checkout worker=system binding=STREAM source_name=checkout-clean
assign_data_source  tenant_id collection=checkout worker=system binding=ENTITY source_name=service:checkout
```

Custom Durable Objects use `worker`/`binding`/`object` coordinates instead of `source_name`.

### Failure Modes

- `403` from a data tool: missing Worker scope or collection permission. Check `list_collections`.
- `404 table not found` from `set_table_policy`: the table has not been created by a Sink yet; run
  the pipeline first.
- `409` on `assign_data_source`: the source already belongs to another collection; create a new
  source name instead.
- `409 SQL alias is already used`: pick another alias.

### Related Skills

- `lakeday-ingest` for creating the streams and tables being governed.
- `lakeday-dashboard` for the view that needs the grant.
- `lakeday-explore` to see what the caller can currently read.
