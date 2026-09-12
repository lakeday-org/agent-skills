import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, openInstruction } from "../hooks/lakeday-hook.mjs";
import { normalize, encodeResponse, lakedayToolName } from "../hooks/lib/adapters.mjs";
import { resolveConfig } from "../hooks/lib/config.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lakeday-hooks-"));
}

function envFor(home, extra = {}) {
  return { LAKEDAY_HOME: home, ...extra };
}

test("lakedayToolName maps harness tool names whatever the server is called", () => {
  assert.equal(lakedayToolName("mcp__lakeday__query_sql"), "query_sql");
  assert.equal(lakedayToolName("mcp__lakeday__session_open"), "session_open");
  // A server named lakeday-staging or lakeday_prod is still Lakeday.
  assert.equal(lakedayToolName("mcp__lakeday-staging__session_decide"), "session_decide");
  assert.equal(lakedayToolName("mcp__lakeday_prod__query_sql"), "query_sql");
  assert.equal(lakedayToolName("mcp__other__query_sql"), null);
  assert.equal(lakedayToolName("mcp__notlakeday__query_sql"), null);
  assert.equal(lakedayToolName("session_decide", "lakeday"), "session_decide");
  assert.equal(lakedayToolName("session_decide", "lakeday-staging"), "session_decide");
  assert.equal(lakedayToolName("session_decide", "other"), null);
  assert.equal(lakedayToolName("Bash"), null);
});

test("normalize handles Claude, Codex, and Cursor payloads", () => {
  const claude = normalize({ hook_event_name: "PostToolUse", session_id: "s1", cwd: "/tmp/p", tool_name: "mcp__lakeday__deploy_pipeline", tool_input: { name: "x" }, tool_response: { ok: true } }, {});
  assert.equal(claude.harness, "claude");
  assert.equal(claude.tool.lakedayTool, "deploy_pipeline");
  const staging = normalize({ hook_event_name: "PostToolUse", session_id: "s3", cwd: "/tmp/p", tool_name: "mcp__lakeday-staging__session_decide", tool_input: {}, tool_response: { type: "decision.recorded" } }, {});
  assert.equal(staging.tool.lakedayTool, "session_decide");
  // Canonical spelling, so anything re-deriving from the name agrees.
  assert.equal(staging.tool.name, "mcp__lakeday__session_decide");
  const codex = normalize({ hook_event_name: "Stop", session_id: "s2", cwd: "/tmp/p", turn_id: "t1", stop_hook_active: true }, {});
  assert.equal(codex.harness, "codex");
  assert.equal(codex.stopActive, true);
  const cursor = normalize({ hook_event_name: "afterMCPExecution", conversation_id: "c1", workspace_roots: ["/tmp/p"], tool_name: "query_sql", mcp_server_name: "lakeday", tool_input: { sql: "select 1" }, result_json: "{\"rows\":[]}" }, {});
  assert.equal(cursor.harness, "cursor");
  assert.equal(cursor.event, "PostToolUse");
  assert.equal(cursor.tool.lakedayTool, "query_sql");
});

test("encodeResponse speaks each dialect", () => {
  assert.deepEqual(JSON.parse(encodeResponse({ harness: "claude", event: "Stop" }, { block: { reason: "record it" } }).stdout), { decision: "block", reason: "record it" });
  assert.equal(JSON.parse(encodeResponse({ harness: "claude", event: "UserPromptSubmit" }, { additionalContext: "ctx" }).stdout).hookSpecificOutput.additionalContext, "ctx");
  assert.deepEqual(JSON.parse(encodeResponse({ harness: "cursor", event: "Stop" }, { block: { reason: "record it" } }).stdout), { followup_message: "record it" });
  assert.deepEqual(JSON.parse(encodeResponse({ harness: "cursor", event: "SessionStart" }, { additionalContext: "ctx" }).stdout), { additional_context: "ctx" });
});

test("config needs no credential and derives the project from the directory", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "Checkout Service-"));
  const config = resolveConfig({ cwd, env: envFor(home) });
  assert.equal(config.enabled, true);
  assert.equal(config.tenant, null);
  assert.match(config.project, /^checkout-service-/);
  fs.mkdirSync(path.join(cwd, ".lakeday"));
  fs.writeFileSync(path.join(cwd, ".lakeday", "agent-skills.json"), JSON.stringify({ tenant_id: "acme", project: "checkout", enforce_decisions: false }));
  const configured = resolveConfig({ cwd, env: envFor(home) });
  assert.equal(configured.tenant, "acme");
  assert.equal(configured.project, "checkout");
  assert.equal(configured.enforceDecisions, false);
  assert.equal(resolveConfig({ cwd, env: envFor(home, { LAKEDAY_HOOKS: "0" }) }).enabled, false);
});

test("the injected instruction opens the session through MCP, then re-projects it", () => {
  const config = { tenant: "acme", project: "checkout" };
  const fresh = openInstruction(config, { sessionKeyName: "claude-checkout-abc" }, { prompt: "Why did checkout failures jump?" });
  assert.match(fresh, /session_open with tenant_id "acme", key "claude-checkout-abc", project "checkout", goal "Why did checkout failures jump\?"/);
  assert.match(fresh, /entity_decide on the object the choice is about/);
  // The decision id must not be confused with the session id.
  assert.match(fresh, /data\.id names the decision itself in short kebab-case/);
  // One reference shape: evidence cites objects, never typed reference kinds.
  assert.match(fresh, /evidence entries \{object, point\}/);
  assert.doesNotMatch(fresh, /subjects/);
  assert.match(fresh, /exposes no session_open, say so once and continue without it/);
  assert.doesNotMatch(fresh, /session_project/);
  const opened = openInstruction(config, { sessionKeyName: "claude-checkout-abc", lakedaySessionId: "os:x:claude-checkout-abc", projectEntity: "os:x:repo-checkout" });
  assert.match(opened, /session_project with tenant_id "acme", id "os:x:claude-checkout-abc", project_entity "os:x:repo-checkout"/);
  assert.doesNotMatch(opened, /session_open/);
  const noTenant = openInstruction({ project: "p" }, { sessionKeyName: "k" });
  assert.match(noTenant, /the deployment id from list_deployments/);
});

test("end to end: no network, learns the session from session_open, blocks once until a decision is recorded", async () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));
  fs.mkdirSync(path.join(cwd, ".lakeday"));
  fs.writeFileSync(path.join(cwd, ".lakeday", "agent-skills.json"), JSON.stringify({ tenant_id: "acme", project: "checkout" }));
  const opts = { env: envFor(home) };
  globalThis.fetch = () => { throw new Error("the hook must not make network calls"); };

  const start = await run({ hook_event_name: "SessionStart", session_id: "abc-123", cwd, source: "startup" }, opts);
  assert.match(start.result.additionalContext, /session_open with tenant_id "acme", key "claude-checkout-abc123", project "checkout"/);

  // The model opens the session; the hook learns the id from the structured result.
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__session_open", tool_input: { tenant_id: "acme", key: "claude-checkout-abc123", project: "checkout" }, tool_response: { structuredContent: { session_id: "os:1:claude-checkout-abc123", project_entity: "os:1:repo-checkout", created: true }, content: [{ type: "text", text: "<lakeday-knowledge>…" }] } }, opts);
  const prompt = await run({ hook_event_name: "UserPromptSubmit", session_id: "abc-123", cwd, prompt: "build it" }, opts);
  assert.match(prompt.result.additionalContext, /Lakeday session: os:1:claude-checkout-abc123 \(project entity os:1:repo-checkout\)/);
  assert.match(prompt.result.additionalContext, /session_project with tenant_id "acme", id "os:1:claude-checkout-abc123"/);

  // Consequential work without a decision blocks the stop once, naming the session.
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__deploy_pipeline", tool_input: { name: "checkout-ingest", source_stream: "a", output_stream: "b", sink_table: "checkout_events" }, tool_response: { pipeline: "checkout-ingest" } }, opts);
  const stop1 = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, stop_hook_active: false }, opts);
  // The nudge names the MCP contract and the concrete project entity the hook learned.
  assert.match(stop1.result.block.reason, /Call entity_decide with id set to the object/);
  assert.match(stop1.result.block.reason, /os:1:repo-checkout/);
  assert.match(stop1.result.block.reason, /set about to os:1:claude-checkout-abc123/);
  assert.match(stop1.result.block.reason, /deploy_pipeline checkout-ingest/);
  const stop1b = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, stop_hook_active: true }, opts);
  assert.equal(stop1b.result, null, "one nudge per turn");

  // Next turn: decision recorded through MCP, then a measurement asks for an outcome.
  await run({ hook_event_name: "UserPromptSubmit", session_id: "abc-123", cwd, prompt: "verify" }, opts);
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__deploy_worker", tool_input: { worker: "w", source: "x" }, tool_response: { ok: true } }, opts);
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__session_decide", tool_input: { id: "os:1:claude-checkout-abc123", data: { id: "deploy-w" } }, tool_response: { type: "decision.recorded" } }, opts);
  const stop2 = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, stop_hook_active: false }, opts);
  assert.equal(stop2.result, null);
  await run({ hook_event_name: "UserPromptSubmit", session_id: "abc-123", cwd, prompt: "measure" }, opts);
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__query_sql", tool_input: { sql: "select count(*) from checkout_events" }, tool_response: { rows: [] } }, opts);
  const stop3 = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, stop_hook_active: false }, opts);
  assert.match(stop3.result.block.reason, /Call entity_outcome with id set to/);
  delete globalThis.fetch;
});

test("without an open session the block tells the model to open one first", async () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nosession-"));
  const opts = { env: envFor(home) };
  await run({ hook_event_name: "UserPromptSubmit", session_id: "z-1", cwd, prompt: "commit" }, opts);
  await run({ hook_event_name: "PostToolUse", session_id: "z-1", cwd, tool_name: "Bash", tool_input: { command: "git commit -m x" }, tool_response: "ok" }, opts);
  const stop = await run({ hook_event_name: "Stop", session_id: "z-1", cwd, stop_hook_active: false }, opts);
  assert.match(stop.result.block.reason, /call session_open with key "claude-nosession-/);
});

test("read-only turns never block and disabled hooks stay silent", async () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-"));
  const opts = { env: envFor(home) };
  await run({ hook_event_name: "UserPromptSubmit", session_id: "r-1", cwd, prompt: "look" }, opts);
  await run({ hook_event_name: "PostToolUse", session_id: "r-1", cwd, tool_name: "mcp__lakeday__list_workers", tool_input: {}, tool_response: { workers: [] } }, opts);
  const stop = await run({ hook_event_name: "Stop", session_id: "r-1", cwd, stop_hook_active: false }, opts);
  assert.equal(stop.result, null);
  const off = await run({ hook_event_name: "SessionStart", session_id: "r-2", cwd }, { env: envFor(home, { LAKEDAY_HOOKS: "0" }) });
  assert.equal(off.result, null);
});
