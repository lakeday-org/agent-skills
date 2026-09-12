#!/usr/bin/env node
// Lakeday hook runtime for Claude Code, Codex, and Cursor.
//
// The hook holds no credential and makes no network calls. Everything that
// touches Lakeday goes through the Lakeday MCP server under the client's own
// OAuth sign-in, performed by the model. The hook does only what a hook can:
//
//   SessionStart / UserPromptSubmit  inject the instruction to open or
//                                    re-project the session (session_open /
//                                    session_project) before working
//   PostToolUse                      keep a local ledger of consequential
//                                    actions and knowledge writes
//   Stop                             block the turn once until consequential
//                                    actions have a recorded decision
//
// Fail-open: without configuration the hook exits 0 with no output.

import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "./lib/config.mjs";
import { normalize, encodeResponse } from "./lib/adapters.mjs";
import {
  classifyTool, clip, knowledgeOperation, normalizeToolCall, sanitizeId, stopVerdict, toolEventData,
} from "@lakeday-org/worker-js/learning";
import { sessionKey, loadState, saveState, emptyTurn } from "./lib/state.mjs";

export async function run(payload, { env = process.env } = {}) {
  const normalized = normalize(payload, env);
  if (normalized.event === "Ignored") return { normalized, result: null };
  const config = resolveConfig({ cwd: normalized.cwd, env });
  const log = makeLogger(config);
  if (!config.enabled) {
    log(`disabled: ${config.reason}`);
    return { normalized, result: null };
  }
  const key = sessionKey(normalized.harness, normalized.sessionId, normalized.cwd);
  const state = loadState(config.home, key);
  if (!state.sessionKeyName) {
    const short = sanitizeId(String(normalized.sessionId ?? "local").replace(/-/g, "").slice(0, 12), 12);
    state.sessionKeyName = sanitizeId(`${normalized.harness}-${config.project}-${short}`, 80);
  }
  try {
    const result = handle(normalized, { config, state, log });
    saveState(config.home, state);
    return { normalized, result };
  } catch (error) {
    log(`error: ${error?.stack ?? error}`);
    try { saveState(config.home, state); } catch { /* ignore */ }
    return { normalized, result: null };
  }
}

/** The instruction injected at the start of a turn. */
export function openInstruction(config, state, { prompt } = {}) {
  const tenant = config.tenant ? `"${config.tenant}"` : "the deployment id from list_deployments";
  const lines = ["<lakeday-hooks>"];
  if (state.lakedaySessionId) {
    lines.push(
      `Lakeday session: ${state.lakedaySessionId}${state.projectEntity ? ` (project entity ${state.projectEntity})` : ""}.`,
      `Before working on this request, call the Lakeday MCP tool session_project with tenant_id ${tenant}, id "${state.lakedaySessionId}"${state.projectEntity ? `, project_entity "${state.projectEntity}"` : ""} and read the returned <lakeday-knowledge> block as the projected state of this session.`,
    );
  } else {
    lines.push(
      `Before working on this request, call the Lakeday MCP tool session_open with tenant_id ${tenant}, key "${state.sessionKeyName}", project "${config.project}"${prompt ? `, goal ${JSON.stringify(clip(prompt, 200))}` : ""}. It creates or resumes your personal session and returns its id plus a <lakeday-knowledge> block; treat that block as the projected state of this session.`,
      "If the Lakeday MCP server is not connected, or it exposes no session_open, say so once and continue without it.",
    );
  }
  lines.push(
    "Record every consequential choice this turn (deployments, ingestion, dashboards, grants, code changes, commits) with entity_decide on the object the choice is about, such as the project entity above: its id argument is that object, and its data carries {id, actor_id, choice, rationale, alternatives, about, evidence}. data.id names the decision itself in short kebab-case, such as restore-timeout, and is never the session id; set about to the session above so the decision points back at where it was made, and cite objects as evidence entries {object, point}. Record measured results of earlier decisions with entity_outcome on the same object, durable facts with entity_fact. The turn cannot finish with unrecorded consequential actions.",
    "</lakeday-hooks>",
  );
  return lines.join("\n");
}

function handle(normalized, { config, state, log }) {
  switch (normalized.event) {
    case "SessionStart":
      state.turn = emptyTurn();
      return { additionalContext: openInstruction(config, state) };
    case "UserPromptSubmit":
      state.turn = emptyTurn();
      return { additionalContext: openInstruction(config, state, { prompt: normalized.prompt }) };
    case "PostToolUse": {
      const tool = normalized.tool ? normalizeToolCall({ ...normalized.tool, serverName: normalized.tool.serverName }) : null;
      if (!tool) return null;
      learnSession(state, tool, log);
      const kind = classifyTool(tool);
      if (kind === "other") return null;
      state.turn.tools.push({ name: tool.name, lakedayTool: tool.lakedayTool, kind, ok: !tool.error, label: clip(toolEventData(tool, normalized.harness).label, 120) });
      if (kind === "recording" && !tool.error) {
        // entity_* and session_* are two namespaces into one object class, so
        // count the operation rather than one spelling of it.
        const operation = knowledgeOperation(tool.lakedayTool);
        if (operation === "decide") { state.turn.decisions++; state.openDecisions = (state.openDecisions ?? 0) + 1; }
        if (operation === "outcome") { state.turn.outcomes++; state.openDecisions = Math.max(0, (state.openDecisions ?? 0) - 1); }
        if (operation === "fact") state.turn.facts++;
      }
      if (kind === "measurement" && (state.openDecisions ?? 0) > 0) state.turn.measuredAfterDecision = true;
      return null;
    }
    case "Stop": {
      const verdict = stopVerdict(state.turn, {
        enforce: config.enforceDecisions,
        maxNudges: config.maxStopBlocksPerTurn,
        stopActive: normalized.stopActive,
        sessionId: state.lakedaySessionId ?? undefined,
        projectEntity: state.projectEntity ?? undefined,
        openDecisions: state.openDecisions ?? 0,
        measuredAfterDecision: state.turn.measuredAfterDecision,
      });
      if (verdict.block) {
        state.turn.nudges = (state.turn.nudges ?? 0) + 1;
        log("blocking stop: decision required");
        const reason = state.lakedaySessionId
          ? verdict.reason
          : `${verdict.reason}\nNo Lakeday session is open yet: call session_open with key "${state.sessionKeyName}" and project "${config.project}" first, then entity_decide on the project entity it returns.`;
        return { block: { reason } };
      }
      state.turn = emptyTurn();
      return null;
    }
    case "PreCompact":
      return { message: "Lakeday: the next prompt re-projects the session from durable events through session_project; nothing depends on the transcript surviving compaction." };
    default:
      return null;
  }
}

/** Learns the session id and project entity from session_open / session_project results. */
function learnSession(state, tool, log) {
  if (tool.lakedayTool !== "session_open" && tool.lakedayTool !== "session_project") return;
  const output = tool.output && typeof tool.output === "object" ? tool.output : {};
  const structured = output.structuredContent && typeof output.structuredContent === "object" ? output.structuredContent : output;
  let sessionId = typeof structured.session_id === "string" ? structured.session_id : null;
  let projectEntity = typeof structured.project_entity === "string" ? structured.project_entity : null;
  if (!sessionId) {
    const text = typeof tool.output === "string" ? tool.output : Array.isArray(output.content) ? output.content.map((c) => c?.text ?? "").join("\n") : JSON.stringify(output);
    const match = /Lakeday session: ([A-Za-z0-9][A-Za-z0-9_.:-]*)/.exec(text);
    if (match) sessionId = match[1];
    const project = /Project entity: ([A-Za-z0-9][A-Za-z0-9_.:-]*)\./.exec(text);
    if (project) projectEntity = project[1];
  }
  if (sessionId && sessionId !== state.lakedaySessionId) {
    state.lakedaySessionId = sessionId;
    log(`session ${sessionId}`);
  }
  if (projectEntity) state.projectEntity = projectEntity;
}

function makeLogger(config) {
  if (!config.debug) return () => {};
  const file = path.join(config.home, "agent-skills", "hooks.log");
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch { /* ignore */ }
  };
}

async function status() {
  const config = resolveConfig({ env: process.env });
  process.stdout.write(`${JSON.stringify({ enabled: config.enabled, tenant: config.tenant ?? null, project: config.project, reason: config.reason ?? null, home: config.home }, null, 2)}\n`);
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "status") return status();
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
  const { normalized, result } = await run(payload);
  const response = encodeResponse(normalized, result);
  if (response.stdout) process.stdout.write(response.stdout);
  process.exitCode = response.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(() => { process.exitCode = 0; });
}
