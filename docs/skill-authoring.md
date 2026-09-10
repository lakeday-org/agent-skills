# Skill authoring

Skills live in `skills/<name>/SKILL.md` with optional `references/` and `artifacts/`. `catalog.json`
is the machine-readable index; `npm run validate` keeps the two in sync.

## Frontmatter

```yaml
---
name: lakeday-<verb-or-noun>
description: One sentence, 40–1024 chars, that says when to use the skill and what it produces.
license: MIT
---
```

`name` must equal the directory. The description is the trigger text harnesses show the model;
lead with the task, name the tools, avoid marketing.

## Body structure

Mirror the existing skills:

1. `## <Title>` — one line of intent.
2. `### Source Of Truth` — what to check live before trusting the skill (tools, resources, docs URLs).
3. `### Default Posture` — the rules that prevent common mistakes. Bullets, imperative, specific.
4. `### Workflow` — numbered steps with exact tool names and argument names.
5. Optional `### Patterns`, `### Failure Modes`, SQL or JSON examples.
6. `### Related Skills` — backticked skill names; the validator rejects unknown names.

Keep SKILL.md under ~150 lines. Move long tables, dialect notes, and code into `references/` and
list every reference file in `catalog.json`.

## Catalog entry

```json
"lakeday-example": {
  "name": "lakeday-example",
  "description": "<identical to frontmatter>",
  "layer": "utility | workflow | use-case",
  "depends_on": ["lakeday-connect"],
  "references": ["references/EXAMPLE.md"],
  "source_docs": ["https://docs.lakeday.ai/..."],
  "needs_live_discovery": true
}
```

- **utility**: one capability (connect, query, CLI).
- **workflow**: a multi-step task that composes utilities (ingest, dashboard).
- **use-case**: an end-to-end outcome (investigate a regression).

## Product-surface rules

- Use real MCP tool names from `edge-router/src/mcp_tools.ts` in the Lakeday monorepo. The
  remaining assumed additions (`stream_load`, `as_of` on `query_sql`) are listed in
  `docs/knowledge-capture.md`; do not invent others.
- Learning logic (projection, classification, provenance, verdict) lives in the published
  `@lakeday-org/worker-js/learning` SDK module, which the hook imports directly. Update the SDK
  package, install it, and run `npm run build`; the build bundles the runtime dependency into each
  distributed plugin hook.
- Every workflow that changes something ends with a `lakeday-record` step. The hooks enforce it;
  the skill should not pretend otherwise.
- Cite dataset versions in evidence. Never instruct the model to paste raw rows into a decision.

## Checks

```sh
npm install
npm run build && npm run validate && npm test
```

Bump `package.json` `version` for a release; `npm run build` propagates it to every manifest.
