import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../hooks/lakeday-hook.mjs";
import { normalize, encodeResponse, lakedayToolName } from "../hooks/lib/adapters.mjs";
import { classifyTool, provenancePlan, stopVerdict, tablesInSql, evidenceFor, fold, SESSION_COMPONENTS, projectSession } from "@lakeday-org/worker-js/learning";
import { createFakeLakeday } from "./fake-lakeday.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lakeday-hooks-"));
}

function envFor(home, extra = {}) {
  return { LAKEDAY_API_KEY: "test-key", LAKEDAY_TENANT_ID: "acme-test", LAKEDAY_API_BASE_URL: "https://api.test", LAKEDAY_HOME: home, ...extra };
}

function writeTranscript(dir, entries) {
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return file;
}

test("lakedayToolName maps harness tool names", () => {
  assert.equal(lakedayToolName("mcp__lakeday__query_sql"), "query_sql");
  assert.equal(lakedayToolName("mcp__other__query_sql"), null);
  assert.equal(lakedayToolName("session_decide", "lakeday"), "session_decide");
  assert.equal(lakedayToolName("session_decide", "other"), null);
  assert.equal(lakedayToolName("Bash"), null);
});

test("normalize handles Claude, Codex, and Cursor payloads", () => {
  const claude = normalize({ hook_event_name: "PostToolUse", session_id: "s1", cwd: "/tmp/p", tool_name: "mcp__lakeday__deploy_pipeline", tool_input: { name: "x" }, tool_response: { ok: true } }, {});
  assert.equal(claude.harness, "claude");
  assert.equal(claude.tool.lakedayTool, "deploy_pipeline");

  const codex = normalize({ hook_event_name: "Stop", session_id: "s2", cwd: "/tmp/p", turn_id: "t1", stop_hook_active: true }, {});
  assert.equal(codex.harness, "codex");
  assert.equal(codex.stopActive, true);

  const cursor = normalize({ hook_event_name: "afterMCPExecution", conversation_id: "c1", workspace_roots: ["/tmp/p"], tool_name: "query_sql", mcp_server_name: "lakeday", tool_input: { sql: "select 1" }, result_json: "{\"rows\":[]}" }, {});
  assert.equal(cursor.harness, "cursor");
  assert.equal(cursor.event, "PostToolUse");
  assert.equal(cursor.tool.lakedayTool, "query_sql");
  assert.deepEqual(cursor.tool.output, { rows: [] });
});

test("encodeResponse speaks each dialect", () => {
  const claudeStop = encodeResponse({ harness: "claude", event: "Stop" }, { block: { reason: "record it" } });
  assert.deepEqual(JSON.parse(claudeStop.stdout), { decision: "block", reason: "record it" });
  const claudeCtx = encodeResponse({ harness: "claude", event: "UserPromptSubmit" }, { additionalContext: "ctx" });
  assert.equal(JSON.parse(claudeCtx.stdout).hookSpecificOutput.additionalContext, "ctx");
  const cursorStop = encodeResponse({ harness: "cursor", event: "Stop" }, { block: { reason: "record it" } });
  assert.deepEqual(JSON.parse(cursorStop.stdout), { followup_message: "record it" });
  const cursorStart = encodeResponse({ harness: "cursor", event: "SessionStart" }, { additionalContext: "ctx" });
  assert.deepEqual(JSON.parse(cursorStart.stdout), { additional_context: "ctx" });
});

test("classifyTool and provenance plans", () => {
  assert.equal(classifyTool({ lakedayTool: "deploy_pipeline" }), "consequential");
  assert.equal(classifyTool({ lakedayTool: "query_sql" }), "measurement");
  assert.equal(classifyTool({ lakedayTool: "session_decide" }), "recording");
  assert.equal(classifyTool({ name: "Edit" }), "code");
  assert.equal(classifyTool({ name: "Bash", input: { command: "git commit -m x" } }), "consequential");
  assert.equal(classifyTool({ name: "Bash", input: { command: "ls" } }), "other");

  const plan = provenancePlan({ lakedayTool: "deploy_pipeline", input: { name: "checkout-ingest", source_stream: "checkout-events", output_stream: "checkout-clean", sink_table: "checkout_events" } }, { sessionId: "s", projectEntity: "repo:checkout" });
  const ids = plan.filter((p) => p.op === "ensure-entity").map((p) => p.id);
  assert.deepEqual(ids, ["pipeline:checkout-ingest", "dataset:checkout-events", "dataset:checkout_events"]);
  assert.equal(plan.filter((p) => p.op === "link").length, 4);

  const load = provenancePlan({ lakedayTool: "stream_load", input: { stream: "checkout-events", source: "s3://bucket/checkout-events.jsonl", format: "jsonl" } }, { sessionId: "s", projectEntity: "repo:checkout" });
  assert.equal(load.find((p) => p.op === "ensure-entity" && p.data.source_kind === "external").data.uri, "s3://bucket/checkout-events.jsonl");
});

test("tablesInSql and evidence", () => {
  assert.deepEqual(tablesInSql("SELECT release, count(*) FROM checkout_events e JOIN releases r ON e.release = r.tag"), ["checkout_events", "releases"]);
  const ev = evidenceFor({ lakedayTool: "run_pipeline", input: { name: "x", sink_table: "checkout_events" }, output: { structuredContent: { table_version: 42 } } });
  assert.deepEqual(ev, [{ kind: "dataset", id: "checkout_events", version: "42" }]);
});

test("stopVerdict blocks once when consequential work lacks a decision", () => {
  const turn = { tools: [{ kind: "consequential", ok: true, label: "deploy_pipeline x" }], decisions: 0, outcomes: 0, stopBlocks: 0 };
  const v = stopVerdict(turn, { enforce: true, maxNudges: 1, stopActive: false, sessionId: "sess" });
  assert.equal(v.block, true);
  assert.match(v.reason, /session_decide/);
  const again = stopVerdict({ ...turn, stopBlocks: 1 }, { enforce: true, maxNudges: 1, stopActive: false, sessionId: "sess" });
  assert.equal(again.block, false);
  const decided = stopVerdict({ ...turn, decisions: 1 }, { enforce: true, maxNudges: 1, stopActive: false, sessionId: "sess" });
  assert.equal(decided.block, false);
  const readOnly = stopVerdict({ tools: [{ kind: "read", ok: true }], decisions: 0, outcomes: 0, stopBlocks: 0 }, { enforce: true, maxNudges: 1, stopActive: false, sessionId: "sess" });
  assert.equal(readOnly.block, false);
  const outcome = stopVerdict({ tools: [{ kind: "measurement", ok: true }], decisions: 0, outcomes: 0, stopBlocks: 0 }, { enforce: true, maxNudges: 1, stopActive: false, sessionId: "sess", openDecisions: 1, measuredAfterDecision: true });
  assert.equal(outcome.block, true);
  assert.match(outcome.reason, /session_outcome/);
});

test("projection folds events into a bounded context block", () => {
  const events = [
    { type: "session.created", sequence: 1, data: { goal: "Investigate checkout failures" } },
    { type: "session.event", sequence: 2, data: { type: "tool.result", tool: "deploy_pipeline", label: "deploy_pipeline checkout-ingest", error: "timeout" } },
    { type: "session.event", sequence: 3, data: { type: "tool.result", tool: "deploy_pipeline", label: "deploy_pipeline checkout-ingest", evidence: [{ kind: "dataset", id: "checkout_events", version: "42" }] } },
    { type: "decision.recorded", sequence: 4, data: { id: "restore-timeout", choice: "Restore the 1,200 ms timeout", rationale: "prior incident", subjects: ["service:checkout"] } },
    { type: "session.context", sequence: 5, data: { summary: "Comparing v41 and v42", plan: ["load", "compare"], open: [] } },
  ];
  const states = fold(SESSION_COMPONENTS, events);
  assert.equal(states.get("uncertain").open.size, 0, "a later success clears the error");
  assert.equal(states.get("decisions").byId.get("restore-timeout").outcomes.length, 0);
  const out = projectSession({ sessionEvents: events, factEvents: [{ type: "fact.asserted", sequence: 1, data: { id: "f1", predicate: "timeout_baseline_ms", value: 1200 } }], priorDecisions: [{ session_id: "old", decision_id: "d1", choice: "Add retries", outcome: "did not help" }], sessionId: "sess", projectEntity: "repo:checkout", tenant: "acme", budget: 3500 });
  assert.match(out.text, /^<lakeday-knowledge>/);
  assert.match(out.text, /Goal: Investigate checkout failures/);
  assert.match(out.text, /restore-timeout: Restore the 1,200 ms timeout \(outcome: not yet measured\)/);
  assert.match(out.text, /Prior decisions about this project/);
  assert.match(out.text, /timeout_baseline_ms: 1200/);
  assert.match(out.text, /dataset:checkout_events@42/);
  assert.ok(out.text.length <= 3500);
  const tiny = projectSession({ sessionEvents: events, factEvents: [], priorDecisions: [], sessionId: "sess", projectEntity: "repo:checkout", tenant: "acme", budget: 400 });
  assert.ok(tiny.text.length <= 400 + 200, "budget trims trailing sections");
});

test("end to end: session lifecycle against the fake Lakeday", async () => {
  const home = tempHome();
  const lake = createFakeLakeday();
  const env = envFor(home);
  const opts = { env, fetch: lake.fetch };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));

  // SessionStart creates the session + project entity and injects context.
  const start = await run({ hook_event_name: "SessionStart", session_id: "abc-123", cwd, source: "startup" }, opts);
  assert.equal(start.normalized.harness, "claude");
  assert.match(start.result.additionalContext, /Lakeday session: u1_claude-/);
  const sessionId = lake.ids("session")[0];
  assert.ok(sessionId.startsWith("u1_claude-"));
  assert.equal(lake.events("session", sessionId)[0].data.participants[0], "u1_user");
  const repoEntity = lake.ids("entity").find((id) => id.includes("repo-"));
  assert.ok(repoEntity, "project entity created");

  // Prompt is captured and context re-projected.
  const prompt = await run({ hook_event_name: "UserPromptSubmit", session_id: "abc-123", cwd, prompt: "Why did checkout failures jump?" }, opts);
  assert.match(prompt.result.additionalContext, /user\.prompt: Why did checkout failures jump\?/);

  // A consequential tool call records provenance entities and links.
  const deploy = await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__deploy_pipeline", tool_input: { tenant_id: "acme-test", name: "checkout-ingest", source_stream: "checkout-events", output_stream: "checkout-clean", sink_table: "checkout_events", transform_module: "export default async (e) => e" }, tool_response: { deployed: true } }, opts);
  assert.match(deploy.result.additionalContext, /recorded provenance/);
  const pipeline = lake.ids("entity").find((id) => id.endsWith("pipeline-checkout-ingest"));
  assert.ok(pipeline);
  const links = lake.events("entity", pipeline).filter((e) => e.type === "relationship.asserted").map((e) => e.data.predicate);
  assert.deepEqual(links.sort(), ["reads_from", "writes_to"]);

  // Read-only tools with no error are not echoed into the session.
  const before = lake.events("session", sessionId).length;
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__list_workers", tool_input: {}, tool_response: { workers: [] } }, opts);
  assert.equal(lake.events("session", sessionId).length, before);

  // Stop without a decision blocks once with instructions.
  const transcript = writeTranscript(cwd, [
    { type: "user", message: { role: "user", content: "Why did checkout failures jump?" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__lakeday__deploy_pipeline", input: {} }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I created the checkout-ingest pipeline." }] } },
  ]);
  const stop1 = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, transcript_path: transcript, stop_hook_active: false }, opts);
  assert.ok(stop1.result.block, "first stop is blocked");
  assert.match(stop1.result.block.reason, new RegExp(`session_decide with id="${sessionId}"`));

  // The model records the decision through MCP; the hook counts it.
  await run({ hook_event_name: "PostToolUse", session_id: "abc-123", cwd, tool_name: "mcp__lakeday__session_decide", tool_input: { id: sessionId, data: { id: "ingest", subjects: [pipeline], choice: "Build the ingestion pipeline", rationale: "need the data" } }, tool_response: { type: "decision.recorded" } }, opts);
  const stop2 = await run({ hook_event_name: "Stop", session_id: "abc-123", cwd, transcript_path: transcript, stop_hook_active: true }, opts);
  assert.equal(stop2.result, null, "second stop proceeds");
  const types = lake.events("session", sessionId).map((e) => e.type);
  assert.ok(types.includes("session.context"), "context replaced at turn end");
  const turn = lake.events("session", sessionId).find((e) => e.data?.type === "assistant.turn");
  assert.equal(turn.data.text, "I created the checkout-ingest pipeline.");

  // PreCompact snapshots context; SessionEnd appends a terminal event.
  const compact = await run({ hook_event_name: "PreCompact", session_id: "abc-123", cwd, transcript_path: transcript, trigger: "auto" }, opts);
  assert.match(compact.result.message, /before compaction/);
  await run({ hook_event_name: "SessionEnd", session_id: "abc-123", cwd, reason: "exit" }, opts);
  assert.equal(lake.events("session", sessionId).at(-1).data.type, "session.ended");
});

test("fenced lakeday-decision blocks are recorded when no MCP tool is available", async () => {
  const home = tempHome();
  const lake = createFakeLakeday();
  const opts = { env: envFor(home), fetch: lake.fetch };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-"));
  await run({ hook_event_name: "UserPromptSubmit", session_id: "f-1", cwd, prompt: "commit it" }, opts);
  const sessionId = lake.ids("session")[0];
  await run({ hook_event_name: "PostToolUse", session_id: "f-1", cwd, tool_name: "Bash", tool_input: { command: "git commit -m x" }, tool_response: "ok" }, opts);
  const noDecision = writeTranscript(cwd, [
    { type: "user", message: { role: "user", content: "commit it" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Committed." }] } },
  ]);
  const first = await run({ hook_event_name: "Stop", session_id: "f-1", cwd, transcript_path: noDecision, stop_hook_active: false }, opts);
  assert.match(first.result.block.reason, /lakeday-decision/);
  const withBlock = writeTranscript(cwd, [
    { type: "user", message: { role: "user", content: "commit it" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Recorded.\n```lakeday-decision\n" + JSON.stringify({ id: "commit-x", subjects: ["repo:checkout"], choice: "Committed x", rationale: "asked", alternatives: [] }) + "\n```" }] } },
  ]);
  const second = await run({ hook_event_name: "Stop", session_id: "f-1", cwd, transcript_path: withBlock, stop_hook_active: true }, opts);
  assert.equal(second.result, null);
  const decision = lake.events("session", sessionId).find((e) => e.type === "decision.recorded");
  assert.equal(decision.data.id, "commit-x");
  assert.equal(decision.data.actor_id, "u1_user");
  // A repeated stop with the same block does not duplicate the decision.
  await run({ hook_event_name: "Stop", session_id: "f-1", cwd, transcript_path: withBlock, stop_hook_active: true }, opts);
  assert.equal(lake.events("session", sessionId).filter((e) => e.type === "decision.recorded").length, 1);
});

test("transcript reader understands Claude and Codex formats", async () => {
  const { lastAssistantTurn, toolUsesInLastTurn } = await import("../hooks/lib/transcript.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  const codex = writeTranscript(dir, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "earlier prompt" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier reply" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<lakeday-knowledge>…</lakeday-knowledge>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "commit it" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "commit"] }), call_id: "c1" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Committed." }] } },
  ]);
  assert.equal(lastAssistantTurn(codex), "Committed.");
  assert.deepEqual(toolUsesInLastTurn(codex), [{ name: "shell", input: { command: ["git", "commit"] } }]);
  const claude = writeTranscript(dir, [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "files" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
  ]);
  assert.equal(lastAssistantTurn(claude), "first\n\nsecond");
});

test("hooks are inert without configuration", async () => {
  const home = tempHome();
  const out = await run({ hook_event_name: "SessionStart", session_id: "x", cwd: home }, { env: { LAKEDAY_HOME: home }, fetch: () => { throw new Error("must not be called"); } });
  assert.equal(out.result, null);
});

test("hooks fail open when Lakeday is unreachable", async () => {
  const home = tempHome();
  const out = await run({ hook_event_name: "UserPromptSubmit", session_id: "x", cwd: home, prompt: "hi" }, { env: envFor(home), fetch: async () => new Response("down", { status: 503 }) });
  assert.equal(out.result, null);
});

test("cursor lifecycle uses followup_message on stop", async () => {
  const home = tempHome();
  const lake = createFakeLakeday();
  const opts = { env: envFor(home), fetch: lake.fetch };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-"));
  await run({ hook_event_name: "sessionStart", conversation_id: "c1", workspace_roots: [cwd] }, opts);
  await run({ hook_event_name: "afterMCPExecution", conversation_id: "c1", workspace_roots: [cwd], tool_name: "create_dashboard", mcp_server_name: "lakeday", tool_input: { name: "checkout-health", document: { queries: { q: { sql: "select * from checkout_events" } } } }, result_json: "{\"id\":\"d1\"}" }, opts);
  const stop = await run({ hook_event_name: "stop", conversation_id: "c1", workspace_roots: [cwd], status: "completed", loop_count: 0 }, opts);
  const encoded = encodeResponse(stop.normalized, stop.result);
  assert.match(JSON.parse(encoded.stdout).followup_message, /session_decide/);
});
