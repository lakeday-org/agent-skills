// Harness adapters: normalize Claude Code, Codex, and Cursor hook payloads into
// one event shape, and encode responses in each harness's dialect.
//
// Normalized event:
//   {
//     harness: "claude" | "codex" | "cursor",
//     event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "PreCompact" | "SessionEnd" | "Ignored",
//     sessionId, cwd, transcriptPath, source,
//     prompt,                       // UserPromptSubmit
//     tool: { name, lakedayTool, input, output, error },   // PostToolUse
//     stopActive,                   // Stop: a previous stop hook already blocked this turn
//     raw
//   }

import { lakedayToolName as lakedayTool, toolError } from "@lakeday-org/worker-js/learning";

// A user names the MCP server whatever they like: lakeday, lakeday-staging,
// lakeday-prod. The shared module recognises the canonical name, so the
// harness-specific spelling is normalised here, which is the adapter's job.
const LAKEDAY_SERVER = /^lakeday(?:[-_].+)?$/;

export function lakedayToolName(name, serverName) {
  if (serverName !== undefined && serverName !== null) {
    return LAKEDAY_SERVER.test(serverName) ? lakedayTool(name, "lakeday") : null;
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name ?? "");
  if (mcp) return LAKEDAY_SERVER.test(mcp[1]) ? lakedayTool(`mcp__lakeday__${mcp[2]}`) : null;
  return lakedayTool(name);
}

/** The canonical spelling, so anything that re-derives the tool from its name
 * (the shared module included) reaches the same answer the adapter did. */
function toolIdentity(name, serverName) {
  const lakedayName = lakedayToolName(name, serverName);
  return { name: lakedayName ? `mcp__lakeday__${lakedayName}` : (name ?? ""), lakedayTool: lakedayName };
}

export function detectHarness(payload, env = process.env) {
  if (env.LAKEDAY_HOOK_HARNESS) return env.LAKEDAY_HOOK_HARNESS;
  if (payload && typeof payload.conversation_id === "string" && typeof payload.hook_event_name === "string" && /^[a-z]/.test(payload.hook_event_name)) return "cursor";
  if (payload && (typeof payload.turn_id === "string" || env.CODEX_HOME || env.CODEX_SANDBOX)) return "codex";
  return "claude";
}

const CURSOR_EVENTS = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  afterMCPExecution: "PostToolUse",
  afterShellExecution: "PostToolUse",
  afterFileEdit: "PostToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUse",
  stop: "Stop",
  preCompact: "PreCompact",
  sessionEnd: "SessionEnd",
};

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function normalize(payload, env = process.env) {
  const harness = detectHarness(payload, env);
  if (harness === "cursor") return normalizeCursor(payload);
  return normalizeClaudeLike(payload, harness);
}

function normalizeClaudeLike(p, harness) {
  const event = p.hook_event_name;
  const base = {
    harness,
    event: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "SessionEnd"].includes(event) ? event : "Ignored",
    sessionId: p.session_id ?? null,
    cwd: p.cwd ?? process.cwd(),
    transcriptPath: p.transcript_path ?? null,
    source: p.source ?? p.trigger ?? p.reason ?? null,
    stopActive: Boolean(p.stop_hook_active),
    raw: p,
  };
  if (event === "UserPromptSubmit") base.prompt = typeof p.prompt === "string" ? p.prompt : "";
  if (event === "PostToolUse") {
    const output = p.tool_response ?? p.tool_output ?? p.result ?? null;
    base.tool = {
      ...toolIdentity(p.tool_name),
      input: p.tool_input ?? {},
      output: parseMaybeJson(output),
      error: toolError(output),
    };
  }
  return base;
}

function normalizeCursor(p) {
  const mapped = CURSOR_EVENTS[p.hook_event_name] ?? "Ignored";
  const cwd = p.cwd ?? (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) ?? process.cwd();
  const base = {
    harness: "cursor",
    event: mapped,
    sessionId: p.conversation_id ?? p.session_id ?? null,
    cwd,
    transcriptPath: p.transcript_path ?? null,
    source: p.trigger ?? p.reason ?? null,
    stopActive: Number(p.loop_count ?? 0) > 0,
    raw: p,
  };
  if (mapped === "UserPromptSubmit") base.prompt = typeof p.prompt === "string" ? p.prompt : "";
  if (mapped === "PostToolUse") {
    switch (p.hook_event_name) {
      case "afterMCPExecution": {
        const output = parseMaybeJson(p.result_json);
        base.tool = { ...toolIdentity(p.tool_name, p.mcp_server_name), input: p.tool_input ?? {}, output, error: toolError(output) };
        break;
      }
      case "afterShellExecution":
        base.tool = { name: "Bash", lakedayTool: null, input: { command: p.command ?? "" }, output: p.output ?? "", error: null };
        break;
      case "afterFileEdit":
        base.tool = { name: "Edit", lakedayTool: null, input: { file_path: p.file_path, edits: p.edits ?? [] }, output: null, error: null };
        break;
      case "postToolUseFailure":
        base.tool = { ...toolIdentity(p.tool_name), input: p.tool_input ?? {}, output: null, error: p.error_message ?? "tool failed" };
        break;
      default:
        base.tool = { ...toolIdentity(p.tool_name), input: p.tool_input ?? {}, output: parseMaybeJson(p.tool_output), error: toolError(p.tool_output) };
    }
  }
  return base;
}

export { toolError };

/**
 * Encodes a hook decision for the harness.
 *   result = { additionalContext?, block?: { reason }, message? }
 * Returns { stdout: string, exitCode: number, stderr?: string }.
 */
export function encodeResponse(normalized, result) {
  const { harness, event } = normalized;
  if (!result) return { stdout: "", exitCode: 0 };
  if (harness === "cursor") return encodeCursor(normalized, result);

  // Claude Code and Codex share one dialect.
  const out = {};
  if (event === "Stop" && result.block) {
    out.decision = "block";
    out.reason = result.block.reason;
    return { stdout: JSON.stringify(out), exitCode: 0 };
  }
  if (result.additionalContext && (event === "SessionStart" || event === "UserPromptSubmit" || event === "PostToolUse")) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  }
  if (result.message) out.systemMessage = result.message;
  return { stdout: Object.keys(out).length ? JSON.stringify(out) : "", exitCode: 0 };
}

function encodeCursor(normalized, result) {
  const { event } = normalized;
  switch (event) {
    case "SessionStart":
      return { stdout: JSON.stringify({ additional_context: result.additionalContext ?? "" }), exitCode: 0 };
    case "UserPromptSubmit":
      return { stdout: JSON.stringify({ continue: true }), exitCode: 0 };
    case "PostToolUse":
      return { stdout: JSON.stringify(result.additionalContext ? { additional_context: result.additionalContext } : {}), exitCode: 0 };
    case "Stop":
      return { stdout: JSON.stringify(result.block ? { followup_message: result.block.reason } : {}), exitCode: 0 };
    case "PreCompact":
      return { stdout: JSON.stringify(result.message ? { user_message: result.message } : {}), exitCode: 0 };
    default:
      return { stdout: "", exitCode: 0 };
  }
}
