# Harness discovery paths

How each coding agent finds skills, hooks, and MCP servers from this repository.

## Claude Code

- Marketplace: `.claude-plugin/marketplace.json` → plugin source `plugins/lakeday-skills-claude`.
- Plugin manifest: `plugins/lakeday-skills-claude/.claude-plugin/plugin.json` with `skills`,
  `hooks` (`hooks/hooks.json`), and `mcpServers` (`.mcp.json`, OAuth: the client discovers the
  AuthKit server from `/.well-known/oauth-protected-resource/mcp`; pass `--client-id` from that
  document when adding manually).
- Hook commands use `${CLAUDE_PLUGIN_ROOT}`; events: `SessionStart`, `UserPromptSubmit`,
  `PostToolUse` (matcher `mcp__lakeday__.*|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch`),
  `Stop`, `PreCompact`, `SessionEnd`.
- Stdin payload fields used: `hook_event_name`, `session_id`, `cwd`, `transcript_path`, `source`,
  `prompt`, `tool_name`, `tool_input`, `tool_response`, `stop_hook_active`, `trigger`.
- Responses: `hookSpecificOutput.additionalContext`, `decision: "block"` + `reason` on Stop,
  `systemMessage`.

## Codex

- Plugin manifest: `.codex-plugin/plugin.json` (repo root) and `plugins/lakeday-skills-codex`.
- Hooks: `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`; same event names and payload
  dialect as Claude Code (`turn_id` distinguishes the harness). Commands use `${CODEX_PLUGIN_ROOT}`
  in the generated plugin, absolute paths from `scripts/install-hooks.mjs`.
- MCP: `~/.codex/config.toml` `[mcp_servers.lakeday]`.
- **Trust**: Codex runs hooks only after they are trusted once in the interactive TUI (`/hooks`,
  persisted under `[hooks.state]` in `config.toml`). Non-interactive automation passes
  `codex exec --dangerously-bypass-hook-trust`. The hook's `additionalContext` is injected as a
  developer message; the Stop hook reads the rollout at `transcript_path`.

## Cursor

- Plugin manifest: `.cursor-plugin/plugin.json` and `plugins/lakeday-skills-cursor`.
- Hooks: `.cursor/hooks.json` (`version: 1`), events `sessionStart`, `beforeSubmitPrompt`,
  `afterMCPExecution`, `afterShellExecution`, `afterFileEdit`, `postToolUseFailure`, `stop`
  (`loop_limit: 2`), `preCompact`, `sessionEnd`.
- Payload fields used: `conversation_id`, `workspace_roots`, `prompt`, `tool_name`,
  `mcp_server_name`, `tool_input`, `result_json`, `command`, `output`, `file_path`, `loop_count`,
  `transcript_path`.
- Responses: `additional_context` (sessionStart, postToolUse), `continue` (beforeSubmitPrompt),
  `followup_message` (stop), `user_message` (preCompact).
- MCP: `.cursor/mcp.json`.

## Other agents

`npx -y skills add lakeday-org/agent-skills` reads `skills/` directly. Install the CLI with
`npm install -g lakeday` so the hooks can call `lk auth token --json`. `mcp/lakeday.mcp.json` is
the generic MCP declaration. Hooks require one of the three harnesses above.

## Detection order in `hooks/lakeday-hook.mjs`

1. `LAKEDAY_HOOK_HARNESS` env override.
2. `conversation_id` + lower-camel `hook_event_name` → Cursor.
3. `turn_id` or `CODEX_HOME` → Codex.
4. Otherwise Claude Code.
