---
name: lakeday-connect
description: Connect Claude Code, Codex, or Cursor to a Lakeday deployment through the MCP server with OAuth, pick a tenant, and enable the knowledge-capture hooks with the same sign-in.
license: MIT
---

## Connect to Lakeday

### Source Of Truth

- Prefer the live MCP server over memory: call `whoami` and `list_deployments` before assuming a tenant.
- `https://api.lakeday.ai/.well-known/oauth-protected-resource/mcp` is the authoritative
  description of how to sign in: it names the AuthKit authorization server and publishes
  `oauth_client_id`. Staging is `https://api-staging.lakeday.ai`.
- The staging public client `client_01M2471MQYGTGQN2B4GVVJJFV3` is registered for the CLI
  callback `http://localhost:3080/`. The CLI's device authorization and fixed localhost PKCE
  callback have been verified with it; no interactive MCP login has been completed against
  staging. Use it for MCP only when the client's callback matches that URI (Claude Code supports
  `--callback-port 3080`).
- The repository's `WORKOS_OAUTH_CLIENT_ID` metadata setting is not deployed yet, so do not assume
  zero-configuration client discovery in staging. DCR-created clients currently receive OIDC-only
  scopes and do not expose device authorization; use a registered public client for Lakeday
  permission scopes.
- Docs: https://docs.lakeday.ai/docs/concepts/mcp and https://docs.lakeday.ai/docs/concepts/authorization.
- The MCP server adds no permissions. A 403 is a missing grant, not a retry.

### Default Posture

- People sign in with OAuth authorization code and PKCE; nothing long-lived is pasted anywhere.
- API keys are for service identities only: CI, scheduled Workers, automation. Never ask a person
  for a key when the OAuth path is available, and never write a key into a file the agent edits.
- One identity serves everything: the MCP server in the client and the hooks
  (which call `lk auth token --json`). The CLI owns token refresh and credential storage.
- Every tool except `whoami`, `list_deployments`, and the dashboard tools takes `tenant_id`.
  Resolve it once and reuse it. The hooks pick it automatically when exactly one deployment is
  visible.

### Workflow

1. Inspect the authorization metadata (it is public; PKCE protects the grant):
   ```sh
   curl -s https://api.lakeday.ai/.well-known/oauth-protected-resource/mcp | jq '{authorization_servers, oauth_client_id}'
   ```
   Clients that support DCR/CIMD can omit a client id. The staging metadata may omit
   `oauth_client_id` until the metadata rollout; do not treat the CLI client above as a generic MCP
   client.
2. Add the MCP server with OAuth:
   - Claude Code: `claude mcp add --transport http lakeday https://api.lakeday.ai/mcp`, then `/mcp`
     → lakeday → Authenticate. This lets a DCR/CIMD-capable client discover its MCP client.
   - Codex: `codex mcp add lakeday --url https://api.lakeday.ai/mcp`, then `codex mcp login lakeday`.
   - Cursor: merge `mcp/lakeday.mcp.json` into `.cursor/mcp.json`; Cursor prompts for the OAuth
     sign-in when the server answers 401. If it cannot complete the flow, use
     `mcp/lakeday.api-key.mcp.json` with a user-owned key as the fallback.
   For a preregistered public MCP client, pass its id (`--client-id` for Claude or
   `--oauth-client-id` for Codex) and ensure its redirect URI matches the harness. Claude Code can
   set a registered loopback port with `--callback-port`. DCR-created clients currently receive
   OIDC-only scopes, so they do not authorize Lakeday permission calls.
3. Verify: `whoami` (a user identity, not an organization key) and `list_deployments` → `tenant_id`.
4. Enable the hooks with the same identity:
   ```sh
   lk login                                    # browser sign-in; set the staging API base URL when needed
   agent=cursor                                 # use claude, codex, or cursor
   skills_dir="${LAKEDAY_SKILLS_DIR:-$HOME/.lakeday/agent-skills}"
   node "$skills_dir/scripts/install-hooks.mjs" --agent "$agent" --scope project --cwd "$PWD"
   node "$skills_dir/plugins/lakeday-skills-$agent/hooks/lakeday-hook.mjs" status
   ```
   A marketplace plugin already supplies its bundled hook. The explicit clone path above is for a
   manual install; set `agent` to the harness being configured.
   Write `.lakeday/agent-skills.json` with `tenant_id` only if more than one deployment is visible.
5. Verify with one read: `query_describe` for the data lake, `session_project` for a known session.

When a client lets you choose OAuth scopes, request AuthKit's `openid profile email offline_access`
scopes plus the Lakeday permissions required by the workflow (`resources:*`, `data:*`, `private:*`,
and `collections:*`) with a registered public client. `openid` alone does not authorize data calls;
DCR-created clients currently receive only the OIDC scopes.

### Service identities

Automation that cannot complete an OAuth flow exports `LAKEDAY_API_KEY` (a user-owned key with
explicit permissions) and, for MCP, uses `mcp/lakeday.api-key.mcp.json` or
`claude mcp add ... --header "Authorization: Bearer $LAKEDAY_API_KEY"`. Organization-only keys
cannot own Sessions or Entities.

### Failure Modes

- `401` from the MCP server: the client has no token yet; run the client's authenticate step.
- `invalid_client` / "Application not found" during sign-in: the client id is not a public Connect
  client for this environment. Use the explicit `oauth_client_id` from the protected-resource
  metadata, or let a client that supports dynamic registration use the issuer's DCR metadata.
- `403` on `entity_*` / `session_*`: missing Worker scope or collection access. See `lakeday-access`.
- `403 OS requires a user identity`: the credential is organization-owned. Sign in as a person.
- `409` on a write: an idempotency key was reused with a different body. Generate a new key.

### Related Skills

- `lakeday-explore` to list collections, tables, and knowledge after connecting.
- `lakeday-access` for collections and grants when a call is refused.
- `lakeday-knowledge` for the session and entity model the hooks maintain.
