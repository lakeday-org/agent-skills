# Install matrix

Install the CLI first with `npm install -g lakeday`; it provides the `lk` command. Every path
installs the same `skills/` catalog. Hooks and the MCP server declaration differ per harness.
Sign-in is OAuth through Lakeday's AuthKit server for both the MCP client and the hooks; the hooks
ask `lk auth token --json` for the active CLI token and stay inert until a token and tenant are
known (auto-detected when exactly one deployment is visible).
Generated plugin packages include a bundled hook executable and its published SDK runtime, so a
fresh plugin install does not need a post-install dependency fetch. A manual source checkout can
run the checked-in generated bundle directly; install dependencies only when rebuilding or testing
the source, as described in the repository README.

| Harness | Skills | Hooks | MCP server |
| --- | --- | --- | --- |
| Claude Code | `/plugin marketplace add lakeday-org/agent-skills` then `/plugin install lakeday-skills@lakeday-skills` | Installed by the plugin (`hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`) | Declared by the plugin (`.mcp.json`, OAuth); or `claude mcp add --transport http lakeday https://api.lakeday.ai/mcp` then `/mcp` → Authenticate (DCR/CIMD) |
| Codex | `codex plugin marketplace add lakeday-org/agent-skills`, enable in `/plugins` | `plugins/lakeday-skills-codex/hooks/hooks.json`; or `node "$HOME/.lakeday/agent-skills/scripts/install-hooks.mjs" --agent codex --scope user`, then trust the hooks once in the TUI (`/hooks`) or pass `--dangerously-bypass-hook-trust` to `codex exec` | `codex mcp add lakeday --url https://api.lakeday.ai/mcp` then `codex mcp login lakeday` (DCR/CIMD) |
| Cursor | `npx -y skills add "$HOME/.lakeday/agent-skills" --agent cursor --skill '*' --yes` after the manual clone below | `node "$HOME/.lakeday/agent-skills/scripts/install-hooks.mjs" --agent cursor --scope project --cwd "$PWD"` writes `.cursor/hooks.json` | Merge `mcp/lakeday.mcp.json` into `.cursor/mcp.json` (OAuth prompt on first 401); `mcp/lakeday.api-key.mcp.json` as the fallback |
| Any other agent | `npx -y skills add lakeday-org/agent-skills` (interactive) | Not available | Use `mcp/lakeday.mcp.json` as the template |

## Manual (no plugin system)

```sh
skills_dir="${LAKEDAY_SKILLS_DIR:-$HOME/.lakeday/agent-skills}"
mkdir -p "$(dirname "$skills_dir")"
git clone https://github.com/lakeday-org/agent-skills "$skills_dir"
node "$skills_dir/scripts/install-hooks.mjs" --agent claude --scope user
node "$skills_dir/scripts/install-hooks.mjs" --agent codex  --scope user
node "$skills_dir/scripts/install-hooks.mjs" --agent cursor --scope user
```

The installer points each harness at the matching generated bundle under
`$skills_dir/plugins/lakeday-skills-<agent>/hooks/`; these manual hooks do not need
`node_modules`. Run the commands with `--scope project --cwd "$PWD"` to install into a
specific project instead of the user configuration.

Project scope (`--scope project`, the default) writes `.claude/settings.json`, `.codex/hooks.json`,
or `.cursor/hooks.json` in the current repository and creates `.lakeday/agent-skills.json` with the
project slug. Commit both if the whole team should capture knowledge into the same tenant.

Skills for a manual install: copy `skills/*` into `~/.claude/skills/`, `~/.codex/skills/`, or
`.cursor/skills/`, or point the harness's skill path at the clone.

## Credentials

Run `lk login` for a person. The hooks call `lk auth token --json` on each activation, so the CLI
owns refreshes and credential storage, including the active directory profile. They never read or
rewrite the CLI's credential files. For automation, set `LAKEDAY_API_KEY` or `LAKEDAY_API_TOKEN`.

Other settings:

- `LAKEDAY_TENANT_ID` or `tenant_id` in `.lakeday/agent-skills.json`: needed only when more than
  one deployment is visible to the user.
- `LAKEDAY_API_BASE_URL`: `https://api-staging.lakeday.ai` for staging.
- `LAKEDAY_OAUTH_CLIENT_ID`: overrides the `oauth_client_id` the server publishes.
- The staging public client `client_01M2471MQYGTGQN2B4GVVJJFV3` is registered for the CLI's
  `http://localhost:3080/` callback. Its CLI device authorization and fixed localhost PKCE
  callback are verified; no interactive MCP login has been completed against staging. Use it for
  MCP only with that registered callback. DCR-created clients have no device authorization and
  currently receive OIDC-only scopes.
- The explicit `WORKOS_OAUTH_CLIENT_ID` metadata setting is awaiting deployment, so staging may
  omit `oauth_client_id` until rollout.
- Organization-only keys cannot own Sessions or Entities (`403 OS requires a user identity`).
- Never commit a key. `.lakeday/agent-skills.json` holds the tenant and options only.
- `node "$HOME/.lakeday/agent-skills/plugins/lakeday-skills-cursor/hooks/lakeday-hook.mjs" status`
  prints which token source is in use and the tenant; use the matching generated bundle for
  Claude or Codex.

## Verify

1. Start a session in a configured project. The first assistant turn should show a
   `<lakeday-knowledge>` block in its context (visible in Claude Code with `ctrl+o` transcript view).
2. Ask the agent to run `session_get` on the session id from that block.
3. Deploy something (or `git commit`) and end the turn without a decision: the Stop hook should ask
   for `session_decide` once.
4. `LAKEDAY_HOOK_DEBUG=1` logs every hook call to `~/.lakeday/agent-skills/hooks.log`.
