# Install matrix

Every path installs the same `skills/` catalog. Hooks and the MCP server declaration differ per
harness. Sign-in is OAuth through Lakeday's AuthKit server, performed by the MCP client. The hooks
hold no credential and make no network calls: they instruct the model to open and re-project the
session through the MCP tools, so every Lakeday call runs under the client's sign-in.

Generated plugin packages include a bundled hook executable and its published SDK runtime, so a
fresh plugin install does not need a post-install dependency fetch. A manual source checkout can
run the checked-in generated bundle directly; install dependencies only when rebuilding or testing
the source, as described in the repository README.

| Harness | Skills | Hooks | MCP server |
| --- | --- | --- | --- |
| Claude Code | `/plugin marketplace add lakeday-org/agent-skills` then `/plugin install lakeday-skills@lakeday-skills` | Installed by the plugin (`hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`) | Declared by the plugin (`.mcp.json`, OAuth); or `claude mcp add --transport http lakeday https://api.lakeday.ai/mcp` then `/mcp` → Authenticate |
| Codex | `codex plugin marketplace add lakeday-org/agent-skills`, enable in `/plugins` | `plugins/lakeday-skills-codex/hooks/hooks.json`; or `node "$HOME/.lakeday/agent-skills/scripts/install-hooks.mjs" --agent codex --scope user`, then trust the hooks once in the TUI (`/hooks`) or pass `--dangerously-bypass-hook-trust` to `codex exec` | `codex mcp add lakeday --url https://api.lakeday.ai/mcp` then `codex mcp login lakeday` |
| Cursor | `npx -y skills add "$HOME/.lakeday/agent-skills" --agent cursor --skill '*' --yes` after the manual clone below | `node "$HOME/.lakeday/agent-skills/scripts/install-hooks.mjs" --agent cursor --scope project --cwd "$PWD"` writes `.cursor/hooks.json` | Merge `mcp/lakeday.mcp.json` into `.cursor/mcp.json` (OAuth prompt on first 401) |
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

## Sign-in

The MCP client does it. Claude Code, Codex, and Cursor discover the AuthKit authorization server
from `/.well-known/oauth-protected-resource/mcp` and run authorization code with PKCE in the
browser. AuthKit follows RFC 8252, so any loopback port works and no callback-port flag is needed.

The client registers itself and requests identity scopes only. Lakeday authorizes on the
signed-in person's live WorkOS role and collection grants rather than on scopes in the token, so no
client id, scope, or callback port is configured anywhere:

| File | Use |
| --- | --- |
| `mcp/lakeday.mcp.json` | Production |
| `mcp/lakeday.staging.mcp.json` | Staging |
| `mcp/lakeday.api-key.mcp.json` | Service identities, using `LAKEDAY_API_KEY` |

Adding a server by hand instead: `claude mcp add --transport http lakeday <url>`, or
`codex mcp add lakeday --url <url>` followed by `codex mcp login lakeday`.

Automation that cannot complete an OAuth flow uses `mcp/lakeday.api-key.mcp.json` with a
user-owned service key. Organization-only keys cannot own Sessions or Entities.

The hooks have no credential to configure. Settings:

- `LAKEDAY_TENANT_ID` or `tenant_id` in `.lakeday/agent-skills.json`: needed only when more than
  one deployment is visible; otherwise the model resolves it with `list_deployments`.
- `LAKEDAY_HOOKS=0` disables the hooks; `LAKEDAY_HOOK_DEBUG=1` logs to `~/.lakeday/agent-skills/hooks.log`.
- `node "$HOME/.lakeday/agent-skills/plugins/lakeday-skills-<agent>/hooks/lakeday-hook.mjs" status`
  prints the resolved project and tenant.

## Verify

1. Start a session in a configured project. The first assistant turn should call `session_open`
   and its result should contain a `<lakeday-knowledge>` block (visible in Claude Code with
   `ctrl+o` transcript view).
2. On the next prompt the assistant should call `session_project` with that session id.
3. Deploy something (or `git commit`) and end the turn without a decision: the Stop hook should ask
   for `session_decide` once.
4. `LAKEDAY_HOOK_DEBUG=1` logs every hook call to `~/.lakeday/agent-skills/hooks.log`.
