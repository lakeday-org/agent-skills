---
name: lakeday-recall
description: Recall prior decisions, outcomes, facts, and links about a subject by reading that object's own history before acting, and load evidence references into working context without the raw data.
license: MIT
---

## Recall before acting

### Source Of Truth

- The `<lakeday-knowledge>` block at the top of the turn is the projection of this session plus the
  project object's own facts and decisions. Start there. Without hooks (or after compaction), call
  `session_project(tenant_id, id=<session>, project_entity, budget?)` to rebuild the same block.
- For anything else, read the object itself: `entity_decisions`, `entity_outcomes`, `entity_facts`,
  `entity_links`, `entity_refs`, `entity_history`.
- There is no shared knowledge table and no publication lag. A read returns the object's own
  durable history; nothing needs syncing.

### Default Posture (Tardigrade context model)

- Context is projected from immutable events, not carried in your head. Re-read the block after
  compaction; it is regenerated from Lakeday, not from the transcript.
- **Recall is a read of the subject.** Decisions are recorded on the object they are about, so
  "what has been decided about this table?" is that table's own `entity_decisions` — one call, not
  a search.
- Load references, not payloads. Keep a decision's record ID, its outcome sentence, and its
  evidence references in working context; do not paste raw query results.
- Ask "have we seen this before?" for every incident, regression, and design choice. A matching
  prior decision with an outcome is the strongest evidence you can cite.
- When you replace raw results with a summary, pin it with `session_context`
  (`{ summary, plan, open, references }`) so the next turn's projection carries it.

### Workflow

1. Identify the subject objects: the service, dataset, release, pipeline, repo, or file involved.
2. `entity_decisions(tenant_id, id=<subject>, limit=20)` → what was decided about it, by anyone,
   newest first.
3. For a promising decision: `entity_decision(tenant_id, id=<subject>, record_id=<decision>)` for
   the original immutable event, and `entity_outcomes(tenant_id, id=<subject>, record_id=<decision>)`
   for what actually happened.
4. `entity_facts(tenant_id, id=<subject>)` → baselines and known causes. The class read returns
   assertions *and* retractions, newest first; a retracted record ID is no longer active.
5. `entity_links(tenant_id, id=<subject>)` → dependencies, lineage, owning project, dashboards.
6. `entity_refs(tenant_id, id=<subject>, object=<other>, kind=<class>)` → this object's own events
   that name another object, when you want the edge between two specific things.
7. To find the sessions that touched a subject, read its `entity_links` for `worked_on_in` edges,
   then `session_context` on each (history only if the context is not enough).
8. Summarize what applies in two or three sentences and cite record IDs and evidence references.
9. Pin the summary: `session_context(tenant_id, id=<this session>, data={ actor_id, summary, references })`.

### Read orders

Getting this wrong silently loses recent records, so it is worth stating plainly:

- `entity_decisions`, `entity_facts`, `entity_links`, `entity_log` are **newest first** and answer
  in one page. Widen with `limit` (max 100), not by paging.
- `entity_history` is **oldest first** and sequence-paged. Follow `next_after` until it is null,
  and keep paging through empty pages — an empty page is normal and does not mean the end.

### Reading the rest of the lake

Knowledge lives in the objects, not in SQL. `query_sql` is for the data: the Lance tables an
investigation measures. Use `query_describe` to see what you can read, and `lakeday-query` for the
SQL itself.

### Related Skills

- `lakeday-knowledge` for what each layer means.
- `lakeday-record` to write the decision that follows the recall.
- `lakeday-query` for measurements over the managed Lance tables.
