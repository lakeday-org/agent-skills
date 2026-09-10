// Transcript reader: extracts the last assistant text of the current turn from
// a Claude Code transcript ({type:"assistant"|"user", message:{content:[...]}})
// or a Codex rollout ({type:"response_item", payload:{type:"message", role,
// content:[{type:"input_text"|"output_text", text}]}}). Cursor supplies
// transcript_path too when available. Bounded and best-effort; never throws.

import fs from "node:fs";

const MAX_BYTES = 2 * 1024 * 1024;

export function readTranscriptTail(transcriptPath, { maxBytes = MAX_BYTES } = {}) {
  if (!transcriptPath) return [];
  let fd;
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - maxBytes);
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift(); // partial first line
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function textOf(message) {
  if (!message) return "";
  const content = message.content ?? message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && ["text", "output_text", "input_text"].includes(c.type) && typeof c.text === "string").map((c) => c.text).join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return "";
}

function roleOf(entry) {
  if (entry.type === "response_item") {
    const p = entry.payload ?? {};
    if (p.type === "message" && (p.role === "assistant" || p.role === "user")) return p.role;
    if (p.type === "function_call") return "assistant";
    if (p.type === "function_call_output") return "tool";
    return null; // developer messages (injected context), reasoning, etc.
  }
  if (entry.type === "assistant" || entry.role === "assistant" || entry.message?.role === "assistant") return "assistant";
  if (entry.type === "user" || entry.role === "user" || entry.message?.role === "user") return "user";
  if (entry.type === "message" && entry.payload?.role) return entry.payload.role;
  return null;
}

/**
 * Returns the assistant text produced since the last human prompt.
 * Tool results are user-role entries without plain text, so they are skipped.
 */
export function lastAssistantTurn(transcriptPath) {
  const entries = readTranscriptTail(transcriptPath);
  const chunks = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const role = roleOf(entry);
    const message = entry.message ?? entry.payload ?? entry;
    if (role === "user") {
      const text = textOf(message);
      const isToolResult = Array.isArray(message?.content) && message.content.some((c) => c?.type === "tool_result");
      if (text.trim() && !isToolResult) break; // reached the human prompt
      continue;
    }
    if (role === "assistant") {
      const text = textOf(message);
      if (text.trim()) chunks.unshift(text.trim());
    }
  }
  return chunks.join("\n\n");
}

/** Counts tool_use blocks by name in the current turn (fallback when PostToolUse was not delivered). */
export function toolUsesInLastTurn(transcriptPath) {
  const entries = readTranscriptTail(transcriptPath);
  const uses = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const role = roleOf(entry);
    const message = entry.message ?? entry.payload ?? entry;
    if (role === "user") {
      const isToolResult = Array.isArray(message?.content) && message.content.some((c) => c?.type === "tool_result");
      if (!isToolResult && textOf(message).trim()) break;
      continue;
    }
    if (role === "assistant" && Array.isArray(message?.content)) {
      for (const block of message.content) if (block?.type === "tool_use") uses.unshift({ name: block.name, input: block.input ?? {} });
    }
    if (role === "assistant" && message?.type === "function_call") {
      let input = {};
      try { input = JSON.parse(message.arguments ?? "{}"); } catch { /* keep empty */ }
      uses.unshift({ name: message.name, input });
    }
  }
  return uses;
}
