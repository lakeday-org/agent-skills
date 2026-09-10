// Local per-session state. Holds only coordination data (Lakeday session id,
// the current turn's tool ledger, block counters). Knowledge itself lives in
// Lakeday; this file can be deleted at any time and the hooks re-derive it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sessionKey(harness, sessionId, cwd) {
  return crypto.createHash("sha256").update(`${harness}\0${sessionId ?? ""}\0${cwd ?? ""}`).digest("hex").slice(0, 24);
}

export function stateDir(home) {
  return path.join(home, "agent-skills", "sessions");
}

export function emptyTurn() {
  return { startedAt: new Date().toISOString(), tools: [], decisions: 0, outcomes: 0, facts: 0, stopBlocks: 0, measuredAfterDecision: false };
}

export function loadState(home, key) {
  const file = path.join(stateDir(home), `${key}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state.turn) state.turn = emptyTurn();
    return state;
  } catch {
    return { key, lakedaySessionId: null, owner: null, projectEntity: null, turn: emptyTurn(), seq: 0, createdAt: new Date().toISOString() };
  }
}

export function saveState(home, state) {
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${state.key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

export function nextSeq(state) {
  state.seq = (state.seq ?? 0) + 1;
  return state.seq;
}
