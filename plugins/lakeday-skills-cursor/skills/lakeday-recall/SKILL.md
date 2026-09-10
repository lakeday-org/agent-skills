---
name: lakeday-recall
description: Recall prior sessions, decisions, outcomes, and facts about a subject from Lakeday before acting, and load evidence references into working context without the raw data.
license: MIT
---

## Recall before acting

### Source Of Truth

- The `<lakeday-knowledge>` block at the top of the turn is the projection of this session plus
  prior decisions about the project entity. Start there. Without hooks (or after compaction),
  call `session_project(tenant_id, id=<session>, project_entity, budget?)` to rebuild the same
  block server-side.
- For anything else: `entity_decisions`, `entity_sessions`, `session_outcomes`, `entity_facts`,
  `entity_relationships`, and SQL over `lk_knowledge`.
- Projection may lag a mutation by a moment; `entity_sync` / `session_sync` repairs pending
  publication.

### Default Posture (Tardigrade context model)

- Context is projected from immutable events, not carried in your head. Re-read the block after
  compaction; it is regenerated from Lakeday, not from the transcript.
- Load references, not payloads. When a prior investigation is relevant, keep its decision ID,
  outcome sentence, and evidence references in working context; do not paste raw query results.
- Ask "have we seen this before?" for every incident, regression, and design choice. A matching
  prior decision with an outcome is the strongest evidence you can cite.
- When you replace raw results with a summary, pin it with `session_context`
  (`{ summary, plan, open, references }`) so the next turn's projection carries it.

### Workflow

1. Identify subject entities: the service, dataset, release, pipeline, or file involved.
2. `entity_decisions(tenant_id, id=<subject>, limit=20)` → prior decisions mentioning it, with
   session IDs.
3. For each promising decision: `session_decision(tenant_id, id=<session>, record_id=<decision>)`
   and `session_outcomes(...)` → what was chosen and what happened.
4. `entity_facts(tenant_id, id=<subject>)` → baselines and known causes; ignore retracted IDs.
5. `entity_relationships(tenant_id, id=<subject>)` → dependencies, lineage, dashboards.
6. `entity_sessions(tenant_id, id=<subject>)` → earlier investigations to skim via
   `session_history(after, limit)`; read `session_context` first, history only if needed.
7. Summarize what applies in two or three sentences and cite decision and dataset references.
8. Pin the summary: `session_context(tenant_id, id=<this session>, data={ summary, references })`.

### Standard queries

```sql
-- Decisions about a subject with outcomes (works across sessions and users you can see)
SELECT d.session_id, d.decision_id, d.label AS choice, d.timestamp, o.label AS outcome
FROM lk_knowledge d
LEFT JOIN lk_knowledge o ON o.type = 'decision.outcome' AND o.row_kind = 'event'
  AND o.session_id = d.session_id AND o.decision_id = d.decision_id
WHERE d.type = 'decision.recorded' AND d.row_kind = 'reference'
  AND d.target_kind = 'entity' AND d.target_id = $1
ORDER BY d.timestamp DESC LIMIT 20;

-- Sessions that touched a dataset
SELECT DISTINCT session_id, max(timestamp) AS last_seen
FROM lk_knowledge WHERE row_kind = 'reference' AND target_kind = 'dataset' AND target_id = $1
GROUP BY session_id ORDER BY last_seen DESC LIMIT 20;

-- Learnings recorded on the project entity
SELECT label AS learning, timestamp FROM lk_knowledge
WHERE type = 'fact.asserted' AND object_id = $1 AND predicate = 'learning'
ORDER BY timestamp DESC LIMIT 20;
```

### Related Skills

- `lakeday-knowledge` for what each layer means.
- `lakeday-record` to write the decision that follows the recall.
- `lakeday-query` for custom `lk_knowledge` queries.
