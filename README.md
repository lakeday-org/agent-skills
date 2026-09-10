# Lakeday Agent Skills

Skills, hooks, and MCP configuration that let Claude Code, Codex, and Cursor build the agentic
data lake on [Lakeday](https://lakeday.ai): ingest third-party data through streams and pipelines,
query Lance tables with DataFusion SQL, publish JSX2UI dashboards, and record every session's
decisions and outcomes so the next session starts smarter.

```text
Why did checkout failures jump? The events are in checkout-events.jsonl in our S3 bucket.
  session_create · deploy_pipeline · stream_load · run_pipeline · query_sql · ui_catalog
  create_dashboard · set_table_policy · collection_grant · inspect_dashboard · render_dashboard
  entity_decisions · session_outcomes · session_decide · session_outcome
```

## What is in the box

| Path | Contents |
| --- | --- |
| `skills/` | 13 skills in three layers (utility, workflow, use-case) plus `catalog.json` |
| `hooks/` | The ALWAYS-mode capture runtime (`lakeday-hook.mjs`) and hook configs for Claude Code / Codex (`hooks.json`) and Cursor (`cursor.hooks.json`) |
| `mcp/` | MCP server declaration for `https://api.lakeday.ai/mcp` |
| `plugins/` | Generated plugin packages per harness (`npm run build`) |
| `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/` | Marketplace and plugin manifests |
| `docs/` | Install matrix, skill authoring, and the knowledge-capture design |

### Skills

| Layer | Skill | Use it to |
| --- | --- | --- |
| utility | `lakeday-connect` | Connect a client, pick a tenant, enable hooks |
| utility | `lakeday-explore` | Inventory Workers, pipelines, collections, tables, dashboards, knowledge |
| utility | `lakeday-query` | DataFusion SQL, parameters, snapshot comparisons, `lk_knowledge` |
| utility | `lakeday-knowledge` | The seven-layer model and the ALWAYS contract |
| utility | `lakeday-web` | Sandboxed search and browser with cited evidence |
| workflow | `lakeday-ingest` | Foreign source → stream → pipeline → table with provenance |
| workflow | `lakeday-workers` | Author, deploy, invoke Workers and Durable Objects |
| workflow | `lakeday-access` | Collections, source assignment, grants, row policies |
| workflow | `lakeday-dashboard` | JSX2UI authoring, validation, publishing, rendering |
| workflow | `lakeday-record` | Decisions, outcomes, facts, links with evidence |
| workflow | `lakeday-recall` | Prior decisions and outcomes before acting |
| use-case | `lakeday-investigate` | The end-to-end regression investigation |
| use-case | `lakeday-knowledge-dashboard` | Evidence / decision / outcome views for people |

## Install

The primary command is `lk`. For a one-off invocation, `npx lakeday <command>`
is also supported.

**Claude Code**

```text
/plugin marketplace add lakeday-org/agent-skills
/plugin install lakeday-skills@lakeday-skills
```

**Codex**

```text
codex plugin marketplace add lakeday-org/agent-skills
```

then enable `lakeday-skills` in `/plugins`.

**Cursor and everything else**

```sh
mkdir -p "$HOME/.lakeday"
git clone https://github.com/lakeday-org/agent-skills "$HOME/.lakeday/agent-skills"
npx -y skills add "$HOME/.lakeday/agent-skills" --agent cursor --skill '*' --yes
node "$HOME/.lakeday/agent-skills/scripts/install-hooks.mjs" \
  --agent cursor --scope project --cwd "$PWD"
```

The clone contains the hook installer and the generated self-contained plugin
bundle; the `--cwd` flag targets the project where Cursor should run the hooks.

Then sign in once, in the client: the MCP server authenticates through Lakeday's AuthKit OAuth
(dynamic client registration, PKCE). The hooks hold no credential at all; they instruct the model
to open and re-project the session through the MCP tools, so every Lakeday call runs under that
sign-in. Automation uses `mcp/lakeday.api-key.mcp.json` with a service key instead. See
`docs/install-matrix.md` for per-harness details.

## How the knowledge capture works

The hooks implement Agno's **ALWAYS** learning mode on top of the coding agent's lifecycle and
inject context Tardigrade-style, projected from immutable Lakeday events:

1. **SessionStart / prompt** — the hook injects one instruction: call `session_open` (first
   turn) or `session_project` (later turns). The MCP server creates or resumes the personal
   Session and project entity and returns the `<lakeday-knowledge>` block: goal, decisions
   (measured or not), unresolved errors, prior decisions about the project, facts, datasets.
2. **Tool calls** — the hook keeps a local ledger. `deploy_pipeline`, `run_pipeline`,
   `create_dashboard`, and `set_table_policy` record entities and lineage links server-side.
3. **Stop** — if the turn changed something and the model recorded no decision through
   `session_decide`, the stop is blocked once with the exact call to make.
4. **PreCompact** — nothing to save; the next prompt re-projects from durable events.

Design and configuration: `docs/knowledge-capture.md`. The hooks are fail-open and hold no credential. The projection and policy code is the Lakeday SDK's
`@lakeday-org/worker-js/learning` module, the same one behind `defineAgent({ learning: "always" })`
and the MCP server's `session_project` tool; the hook imports the published package directly.
`npm run build` bundles that dependency into each distributed plugin hook, so a plugin install
does not need a post-install network fetch.

## Develop

```sh
npm install        # install the SDK runtime and esbuild used by source hooks and builds
npm run build      # regenerate plugins/ from skills/, hooks/, mcp/
npm run validate   # frontmatter, catalog, references, versions, plugin sync
npm test           # hook runtime tests against an in-memory Lakeday
```

Authoring conventions: `docs/skill-authoring.md`. Harness discovery paths: `HARNESSES.md`.

## License

MIT.
