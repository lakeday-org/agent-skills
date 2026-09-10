#!/usr/bin/env node
// Lakeday hook runtime for Claude Code, Codex, and Cursor.
//
// Reads one hook payload from stdin, captures the interaction into Lakeday
// (Sessions, Entities, decisions, outcomes) in ALWAYS mode, projects the
// session's knowledge Tardigrade-style from immutable events, and writes the
// harness-specific response to stdout.
//
// Fail-open: any configuration or network problem exits 0 with no output so
// the coding agent is never blocked by Lakeday being unavailable.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./lib/config.mjs";
import { cliPath, discoverTenant, resolveToken, safeErrorCode } from "./lib/auth.mjs";
import { normalize, encodeResponse } from "./lib/adapters.mjs";
import { LakedayClient, idempotencyKey } from "./lib/client.mjs";
// One implementation shared with the Lakeday SDK, the V8 agent harness, and
// the MCP server; this package is bundled into distributed plugin hooks.
import {
  SESSION_COMPONENTS, classifyTool, clip, extractKnowledgeBlocks, fold, normalizeToolCall, projectSession,
  provenancePlan, sanitizeId, stopVerdict, summarizeForContext, toolEventData,
} from "@lakeday-org/worker-js/learning";
import { lastAssistantTurn } from "./lib/transcript.mjs";
import { sessionKey, loadState, saveState, emptyTurn, nextSeq } from "./lib/state.mjs";

const PRIOR_DECISIONS_SQL = `
SELECT session_id, decision_id, actor_id, label AS choice, timestamp
FROM lk_knowledge
WHERE type = 'decision.recorded' AND row_kind = 'reference'
  AND target_kind = 'entity' AND target_id = $1
ORDER BY timestamp DESC
LIMIT 12`;

const OUTCOMES_SQL = `
SELECT session_id, decision_id, label AS outcome, timestamp
FROM lk_knowledge
WHERE type = 'decision.outcome' AND row_kind = 'event' AND session_id = ANY($1)
ORDER BY timestamp DESC
LIMIT 50`;

/** Resolves the OAuth (or env) credential and the tenant; mutates config. */
export async function activate(config, { env = process.env, fetch: fetchImpl = globalThis.fetch, execFile: execFileImpl, cwd = process.cwd(), log = () => {} } = {}) {
  if (!config.token) {
    const resolved = await resolveToken({ baseUrl: config.baseUrl, home: config.home, cwd, env, execFile: execFileImpl, log });
    config.token = resolved.token;
    config.tokenSource = resolved.source;
    if (!resolved.token) {
      config.reason = `no credential: ${resolved.hint}`;
      return config;
    }
  } else {
    config.tokenSource = "env";
  }
  if (!config.tenant) {
    try {
      config.tenant = await discoverTenant({ baseUrl: config.baseUrl, token: config.token, home: config.home, fetch: fetchImpl, log });
    } catch (error) {
      log(`tenant discovery failed: ${error.message}`);
    }
    if (!config.tenant) {
      config.reason = "no tenant: set tenant_id in .lakeday/agent-skills.json or LAKEDAY_TENANT_ID (more than one deployment is visible)";
      return config;
    }
  }
  config.enabled = true;
  return config;
}

export async function run(payload, { env = process.env, fetch: fetchImpl, execFile: execFileImpl, now = () => new Date() } = {}) {
  const normalized = normalize(payload, env);
  const config = resolveConfig({ cwd: normalized.cwd, env });
  const log = makeLogger(config);
  if (normalized.event === "Ignored") return { normalized, result: null };
  try {
    await activate(config, { env, fetch: fetchImpl ?? globalThis.fetch, execFile: execFileImpl, cwd: normalized.cwd, log });
  } catch (error) {
    log(`activation failed: ${error.message}`);
  }
  if (!config.enabled) {
    log(`disabled: ${config.reason}`);
    return { normalized, result: null };
  }
  const client = new LakedayClient(config, { fetch: fetchImpl, log });
  const key = sessionKey(normalized.harness, normalized.sessionId, normalized.cwd);
  const state = loadState(config.home, key);
  try {
    const result = await handle(normalized, { config, client, state, log, now });
    saveState(config.home, state);
    return { normalized, result };
  } catch (error) {
    log(`error: ${error?.stack ?? error}`);
    try { saveState(config.home, state); } catch { /* ignore */ }
    return { normalized, result: null };
  }
}

async function ensureSession(normalized, { config, client, state, log }) {
  const owner = await client.me();
  state.owner = { prefix: owner.prefix, actor: owner.actor };
  if (!state.lakedaySessionId) {
    const short = sanitizeId(String(normalized.sessionId ?? "local").replace(/-/g, "").slice(0, 12), 12);
    state.lakedaySessionId = await client.personalId(`${normalized.harness}-${config.project}-${short}`);
  }
  if (!state.projectEntity) {
    state.projectEntity = config.sharedEntities ? config.projectEntity : await client.personalId(config.projectEntity.replace(/^repo:/, "repo-"));
  }
  const goal = `${normalized.harness} session in ${config.project}`;
  const { created } = await client.ensure("session", state.lakedaySessionId, {
    participants: [owner.actor],
    goal,
    harness: normalized.harness,
    cwd: normalized.cwd,
    project: config.project,
    project_entity: state.projectEntity,
    harness_session_id: normalized.sessionId,
  });
  await client.ensure("entity", state.projectEntity, { type: "repo", name: config.project, actor_id: owner.actor });
  if (created) {
    log(`created session ${state.lakedaySessionId}`);
    await client.mutate("entity", state.projectEntity, "/relationships", {
      id: sanitizeId(`session-${state.lakedaySessionId}`),
      predicate: "worked_on_in",
      target: { kind: "session", id: state.lakedaySessionId },
      session_id: state.lakedaySessionId,
    }, idempotencyKey("link-session", state.lakedaySessionId));
  }
  return state.lakedaySessionId;
}

async function projectedContext({ config, client, state, log }) {
  const sessionId = state.lakedaySessionId;
  const [sessionEvents, factEvents, priorDecisions] = await Promise.all([
    client.history("session", sessionId, { limit: 300 }).catch((e) => (log(`history failed: ${e.message}`), [])),
    client.facts("entity", state.projectEntity).catch((e) => (log(`facts failed: ${e.message}`), [])),
    config.recallPriorDecisions ? recallPriorDecisions(client, state.projectEntity, log) : Promise.resolve([]),
  ]);
  return projectSession({
    sessionEvents, factEvents, priorDecisions,
    sessionId, projectEntity: state.projectEntity, tenant: config.tenant,
    budget: config.contextBudgetChars,
  });
}

async function recallPriorDecisions(client, projectEntity, log) {
  try {
    const decisions = await client.sql(PRIOR_DECISIONS_SQL, [projectEntity], 12);
    const rows = rowsOf(decisions);
    if (!rows.length) return [];
    const sessions = [...new Set(rows.map((r) => r.session_id))];
    let outcomes = [];
    try { outcomes = rowsOf(await client.sql(OUTCOMES_SQL, [sessions], 50)); } catch (e) { log(`outcomes recall failed: ${e.message}`); }
    return rows.map((r) => ({ ...r, outcome: outcomes.find((o) => o.session_id === r.session_id && o.decision_id === r.decision_id)?.outcome ?? null }));
  } catch (e) {
    log(`prior decision recall failed: ${e.message}`);
    return [];
  }
}

function rowsOf(result) {
  if (!result) return [];
  if (Array.isArray(result.rows) && Array.isArray(result.columns)) {
    return result.rows.map((row) => Array.isArray(row) ? Object.fromEntries(result.columns.map((c, i) => [typeof c === "string" ? c : c.name, row[i]])) : row);
  }
  return Array.isArray(result) ? result : [];
}

async function handle(normalized, ctx) {
  const { config, client, state, log } = ctx;
  switch (normalized.event) {
    case "SessionStart": {
      await ensureSession(normalized, ctx);
      state.turn = emptyTurn();
      if (normalized.source && normalized.source !== "startup") {
        await appendEvent(ctx, { type: "session.resumed", label: `${normalized.harness} ${normalized.source}` });
      }
      const projection = await projectedContext(ctx);
      return { additionalContext: projection.text };
    }
    case "UserPromptSubmit": {
      await ensureSession(normalized, ctx);
      state.turn = emptyTurn();
      await appendEvent(ctx, { type: "user.prompt", text: clip(normalized.prompt, 2000), label: clip(normalized.prompt, 160) });
      const projection = await projectedContext(ctx);
      return { additionalContext: projection.text };
    }
    case "PostToolUse": {
      const tool = normalized.tool ? normalizeToolCall({ ...normalized.tool, serverName: normalized.tool.serverName }) : null;
      if (!tool) return null;
      const kind = classifyTool(tool);
      if (kind === "other") return null;
      await ensureSession(normalized, ctx);
      state.turn.tools.push({ name: tool.name, lakedayTool: tool.lakedayTool, kind, ok: !tool.error, label: clip(toolEventData(tool, normalized.harness).label, 120) });
      if (kind === "recording") {
        if (tool.lakedayTool === "session_decide" && !tool.error) state.turn.decisions++;
        if (tool.lakedayTool === "session_outcome" && !tool.error) state.turn.outcomes++;
        if (tool.lakedayTool === "entity_fact" && !tool.error) state.turn.facts++;
        return null; // the model already wrote knowledge; do not echo it
      }
      if (kind === "measurement" && sessionHasOpenDecision(state)) state.turn.measuredAfterDecision = true;
      if (kind !== "read") {
        await appendEvent(ctx, toolEventData(tool, normalized.harness));
      } else if (tool.error) {
        await appendEvent(ctx, toolEventData(tool, normalized.harness));
      }
      // The MCP server records provenance itself for deploy_pipeline, run_pipeline,
      // create_dashboard, and set_table_policy; the hook only fills the gaps.
      const structured = tool.output && typeof tool.output === "object" ? (tool.output.structuredContent ?? tool.output) : null;
      const serverProvenance = structured && typeof structured.provenance === "object" && structured.provenance ? structured.provenance : null;
      const recorded = serverProvenance
        ? (Array.isArray(serverProvenance.recorded) ? serverProvenance.recorded : [])
        : await executeProvenance(provenancePlan(tool, { sessionId: state.lakedaySessionId, projectEntity: state.projectEntity }), ctx);
      if (recorded.length) {
        return { additionalContext: `Lakeday recorded provenance: ${recorded.join(", ")}. Reference these entity ids as subjects when you record the decision.` };
      }
      return null;
    }
    case "Stop": {
      await ensureSession(normalized, ctx);
      const turnText = lastAssistantTurn(normalized.transcriptPath);
      // Fallback recording channel: fenced lakeday-decision / lakeday-outcome /
      // lakeday-fact blocks in the reply, for harnesses without the MCP server.
      await recordFencedBlocks(ctx, extractKnowledgeBlocks(turnText));
      const verdict = stopVerdict(state.turn, {
        enforce: config.enforceDecisions,
        maxNudges: config.maxStopBlocksPerTurn,
        stopActive: normalized.stopActive,
        sessionId: state.lakedaySessionId,
        openDecisions: state.openDecisions ?? 0,
        measuredAfterDecision: state.turn.measuredAfterDecision,
      });
      if (verdict.block) {
        state.turn.stopBlocks++;
        log("blocking stop: decision required");
        return { block: { reason: verdict.reason } };
      }
      if (turnText) await appendEvent(ctx, { type: "assistant.turn", text: clip(turnText, 2000), label: clip(turnText, 160) });
      await replaceContext(ctx, { reason: "turn", turnSummary: turnText });
      state.turn = emptyTurn();
      return null;
    }
    case "PreCompact": {
      await ensureSession(normalized, ctx);
      await replaceContext(ctx, { reason: "compaction", turnSummary: lastAssistantTurn(normalized.transcriptPath) });
      await appendEvent(ctx, { type: "compaction", label: `${normalized.harness} ${normalized.source ?? "compact"}` });
      return { message: "Lakeday saved the session context before compaction; the next prompt re-injects it." };
    }
    case "SessionEnd": {
      if (!state.lakedaySessionId) return null;
      await client.me();
      await appendEvent(ctx, { type: "session.ended", label: normalized.source ?? "end" });
      return null;
    }
    default:
      return null;
  }
}

function sessionHasOpenDecision(state) {
  return (state.openDecisions ?? 0) > 0 || state.turn.decisions > 0;
}

async function recordFencedBlocks({ client, state, log }, blocks) {
  state.recordedBlocks ??= [];
  const seen = new Set(state.recordedBlocks);
  const sessionId = state.lakedaySessionId;
  const actor = state.owner?.actor;
  for (const decision of blocks.decisions) {
    const key = `decision:${decision.id}`;
    if (seen.has(key)) continue;
    try {
      await client.mutate("session", sessionId, "/decisions", { ...decision, actor_id: actor }, idempotencyKey("fenced", sessionId, key));
      state.turn.decisions++;
      state.recordedBlocks.push(key);
      log(`recorded fenced decision ${decision.id}`);
    } catch (error) {
      if (error?.status === 409) { state.turn.decisions++; state.recordedBlocks.push(key); }
      else log(`fenced decision failed: ${error.message}`);
    }
  }
  for (const outcome of blocks.outcomes) {
    const key = `outcome:${outcome.decision_id}:${clip(outcome.outcome, 40)}`;
    if (seen.has(key)) continue;
    const { decision_id, ...data } = outcome;
    try {
      await client.mutate("session", sessionId, `/decisions/${encodeURIComponent(decision_id)}/outcomes`, { ...data, actor_id: actor }, idempotencyKey("fenced", sessionId, key));
      state.turn.outcomes++;
      state.recordedBlocks.push(key);
    } catch (error) {
      if (error?.status !== 409) log(`fenced outcome failed: ${error.message}`);
    }
  }
  for (const fact of blocks.facts) {
    const key = `fact:${fact.entity ?? "project"}:${fact.id}`;
    if (seen.has(key)) continue;
    const { entity, ...data } = fact;
    const target = entity ?? state.projectEntity;
    try {
      await client.mutate("entity", target, "/facts", { ...data, actor_id: actor, session_id: sessionId }, idempotencyKey("fenced", sessionId, key));
      state.turn.facts++;
      state.recordedBlocks.push(key);
    } catch (error) {
      if (error?.status !== 409) log(`fenced fact failed: ${error.message}`);
    }
  }
}

async function appendEvent({ client, state }, data) {
  const seq = nextSeq(state);
  const body = { ...data, seq };
  return client.mutate("session", state.lakedaySessionId, "/events", body, idempotencyKey("event", state.lakedaySessionId, seq, data.type, data.label ?? ""));
}

async function replaceContext(ctx, { reason, turnSummary }) {
  const { client, state, log } = ctx;
  const events = await client.history("session", state.lakedaySessionId, { limit: 300 }).catch((e) => (log(`history failed: ${e.message}`), []));
  const states = fold(SESSION_COMPONENTS, events);
  const decisions = states.get("decisions");
  state.openDecisions = decisions.order.filter((id) => decisions.byId.get(id).outcomes.length === 0).length;
  const context = summarizeForContext(states, { reason, turnSummary });
  const seq = nextSeq(state);
  await client.mutate("session", state.lakedaySessionId, "/context", { ...context, seq }, idempotencyKey("context", state.lakedaySessionId, seq));
}

async function executeProvenance(plan, { client, state, log }) {
  const recorded = [];
  const owner = state.owner;
  for (const step of plan) {
    try {
      if (step.op === "ensure-entity") {
        const id = resolveEntityId(step.id, state, client);
        const { created } = await client.ensure("entity", id, { ...step.data, actor_id: owner.actor });
        if (created) recorded.push(id);
      } else if (step.op === "link") {
        const from = resolveEntityId(step.entity, state, client);
        const target = step.data.target.kind === "entity" ? { ...step.data.target, id: resolveEntityId(step.data.target.id, state, client) } : step.data.target;
        await client.mutate("entity", from, "/relationships", { ...step.data, target, actor_id: owner.actor }, idempotencyKey("link", from, step.data.id));
      }
    } catch (error) {
      if (error?.status === 409) continue; // already recorded
      log(`provenance step failed (${step.op} ${step.id ?? step.entity}): ${error.message}`);
    }
  }
  return recorded;
}

/** Personal deployments prefix generated ids; shared deployments use them verbatim. */
function resolveEntityId(id, state, client) {
  if (id === state.projectEntity) return id;
  if (client.config.sharedEntities) return id;
  const prefix = state.owner?.prefix ?? "";
  if (id.startsWith(prefix)) return id;
  return `${prefix}${sanitizeId(id.replace(":", "-"), 120 - prefix.length)}`;
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

export function login(args = [], { env = process.env, spawn: spawnImpl = nodeSpawn, stderr = process.stderr } = {}) {
  const child = spawnImpl(cliPath(env), ["login", ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(typeof code === "number" ? code : 1);
    };
    child.once("error", (error) => {
      stderr.write(`lk login failed (${safeErrorCode(error)})\n`);
      finish(1);
    });
    child.once("exit", (code) => finish(code));
  });
}

async function status() {
  const config = resolveConfig({ env: process.env });
  await activate(config, { env: process.env, fetch: globalThis.fetch });
  process.stdout.write(JSON.stringify({ enabled: config.enabled, base_url: config.baseUrl, tenant: config.tenant, credential: config.tokenSource ?? "none", project: config.project, reason: config.reason ?? null }, null, 2) + "\n");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "login") {
    process.exitCode = await login(rest);
    return;
  }
  if (command === "status" || command === "whoami") return status();
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
  const { normalized, result } = await run(payload);
  const response = encodeResponse(normalized, result);
  if (response.stdout) process.stdout.write(response.stdout);
  process.exitCode = response.exitCode;
}

function isMainModule() {
	if (!process.argv[1]) return false;
	const modulePath = fileURLToPath(import.meta.url);
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
	} catch {
		return path.resolve(process.argv[1]) === modulePath;
	}
}

if (isMainModule()) {
  main().catch((error) => {
    if (process.argv[2] === "login" || process.argv[2] === "status" || process.argv[2] === "whoami") {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else process.exitCode = 0;
  });
}
