---
name: lakeday-connect
description: Connect Claude Code, Codex, or Cursor to a Lakeday deployment through the MCP server with OAuth, pick a tenant, and enable the knowledge-capture hooks, which run under that same sign-in.
license: MIT
---

## Connect to Lakeday

### Source Of Truth

- Prefer the live MCP server over memory: call `whoami` and `list_deployments` before assuming a tenant.
- `https://api.lakeday.ai/.well-known/oauth-protected-resource/mcp` is the authoritative
  description of how to sign in: it names the AuthKit authorization server and, once deployed,
  publishes `oauth_client_id`. Staging is `https://api-staging.lakeday.ai`.
- Docs: https://docs.lakeday.ai/docs/concepts/mcp and https://docs.lakeday.ai/docs/concepts/authorization.
- The MCP server adds no permissions. A 403 is a missing grant, not a retry.

### Default Posture

- People sign in with OAuth in the client: authorization code with PKCE against AuthKit, with
  dynamic client registration when the client supports it. Nothing long-lived is pasted anywhere.
- API keys are for service identities only: CI, scheduled Workers, automation. Never ask a person
  for a key when the OAuth path is available, and never write a key into a file the agent edits.
- One identity serves everything. The hooks hold no credential and make no network calls: they
  tell the model to open and re-project the session through the MCP tools `session_open` and
  `session_project`, so every Lakeday call runs under the client's sign-in.
- Every tool except `whoami`, `list_deployments`, and the dashboard tools takes `tenant_id`.
  Resolve it once and reuse it.

### Workflow

1. Add the MCP server with OAuth:
   - Claude Code: `claude mcp add --transport http lakeday https://api.lakeday.ai/mcp`, then `/mcp`
     → lakeday → Authenticate.
   - Codex: `codex mcp add lakeday --url https://api.lakeday.ai/mcp`, then `codex mcp login lakeday`.
   - Cursor: merge `mcp/lakeday.mcp.json` into `.cursor/mcp.json`; Cursor prompts for the OAuth
     sign-in when the server answers 401.
   The configs in `mcp/` already carry the client id where one is required, so nothing needs to
   be passed by hand. Adding a server manually against staging needs
   `--client-id client_01M2471MQYGTGQN2B4GVVJJFV3` (Claude Code) or `--oauth-client-id` (Codex),
   because AuthKit refuses Lakeday scopes to self-registering clients. AuthKit follows RFC 8252, so
   any loopback port works and no `--callback-port` is needed.
2. Verify: `whoami` (a user identity, not an organization key) and `list_deployments` → `tenant_id`.
3. Install the hooks (no sign-in of their own):
   ```sh
   node scripts/install-hooks.mjs --agent claude|codex|cursor --scope project
   ```
   A marketplace plugin already supplies its bundled hook. Write `.lakeday/agent-skills.json` with
   `tenant_id` only if more than one deployment is visible.
4. Verify with one read: `query_describe` for the data lake; `session_open` with a test key to
   confirm knowledge access. `session_open` provisions your personal collection and binds its
   sources on first use, so no collection setup is needed by hand.

When a client lets you choose OAuth scopes, request AuthKit's `openid profile email offline_access`
plus the Lakeday permissions the workflow needs (`resources:*`, `data:*`, `private:*`,
`collections:*`). `openid` alone does not authorize data calls.

### Service identities

Automation that cannot complete an OAuth flow exports `LAKEDAY_API_KEY` (a user-owned key with
explicit permissions) and, for MCP, uses `mcp/lakeday.api-key.mcp.json` or
`claude mcp add ... --header "Authorization: Bearer $LAKEDAY_API_KEY"`. Organization-only keys
cannot own Sessions or Entities.

### Failure Modes

- `401` from the MCP server: the client has no token yet; run the client's authenticate step.
- `invalid_client` during sign-in: the client id is not registered with this AuthKit environment.
  Let the client register dynamically, or use the environment's published `oauth_client_id`.
- `403` on data or knowledge tools right after a successful sign-in: the token carries only OIDC
  scopes. The client must request the Lakeday scopes above; a dynamically registered client may
  not be allowed them, in which case an operator registers a public client for the environment.
- `403` on `entity_*` / `session_*`: missing Worker scope or collection access. See `lakeday-access`.
- `403 OS requires a user identity`: the credential is organization-owned. Sign in as a person.
- `409` on a write: an idempotency key was reused with a different body. Generate a new key.

### Related Skills

- `lakeday-explore` to list collections, tables, and knowledge after connecting.
- `lakeday-access` for collections and grants when a call is refused.
- `lakeday-knowledge` for the session and entity model the hooks enforce.
