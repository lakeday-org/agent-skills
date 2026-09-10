#!/usr/bin/env node
// Installs the Lakeday hooks into a harness config without a plugin system.
//
//   node scripts/install-hooks.mjs --agent claude|codex|cursor [--scope project|user] [--cwd DIR]
//
// Writes absolute hook commands so the config works from any directory, and
// merges into an existing hooks file without dropping other hooks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : []).filter(Boolean));
const agent = args.agent;
const scope = args.scope ?? "project";
const cwd = path.resolve(args.cwd ?? process.cwd());
if (!["claude", "codex", "cursor"].includes(agent)) {
  console.error("usage: install-hooks --agent claude|codex|cursor [--scope project|user] [--cwd DIR]");
  process.exit(2);
}

// Manual installs use the checked-in generated bundle for their harness. The
// canonical hook imports the SDK directly and is for development; the bundle
// keeps a source checkout usable without installing node_modules.
const hookScript = path.join(root, "plugins", `lakeday-skills-${agent}`, "hooks", "lakeday-hook.mjs");
if (!fs.existsSync(hookScript)) {
  console.error(`generated hook missing at ${hookScript}; run npm run build first`);
  process.exit(1);
}
const command = `node "${hookScript}"`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const LAKEDAY_MARK = "lakeday-hook.mjs";

if (agent === "cursor") {
  const template = JSON.parse(fs.readFileSync(path.join(root, "hooks", "cursor.hooks.json"), "utf8"));
  const file = scope === "user" ? path.join(os.homedir(), ".cursor", "hooks.json") : path.join(cwd, ".cursor", "hooks.json");
  const existing = readJson(file) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks ??= {};
  for (const [event, entries] of Object.entries(template.hooks)) {
    const kept = (existing.hooks[event] ?? []).filter((h) => !String(h.command).includes(LAKEDAY_MARK));
    existing.hooks[event] = [...kept, ...entries.map((h) => ({ ...h, command: h.command.replace(/node "\$\{LAKEDAY_SKILLS_ROOT\}\/hooks\/lakeday-hook\.mjs"/, command) }))];
  }
  writeJson(file, existing);
  console.log(`installed Cursor hooks in ${file}`);
} else {
  const template = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
  let file;
  if (agent === "claude") file = scope === "user" ? path.join(os.homedir(), ".claude", "settings.json") : path.join(cwd, ".claude", "settings.json");
  else file = scope === "user" ? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "hooks.json") : path.join(cwd, ".codex", "hooks.json");
  const existing = readJson(file) ?? {};
  existing.hooks ??= {};
  for (const [event, groups] of Object.entries(template.hooks)) {
    const kept = (existing.hooks[event] ?? []).filter((g) => !JSON.stringify(g).includes(LAKEDAY_MARK));
    const rewritten = groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: h.command.replace(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/lakeday-hook\.mjs"/, command) })) }));
    existing.hooks[event] = [...kept, ...rewritten];
  }
  writeJson(file, existing);
  console.log(`installed ${agent} hooks in ${file}`);
  if (agent === "codex") console.log("Codex runs hooks only after you trust them once in the TUI (/hooks); non-interactive runs need: codex exec --dangerously-bypass-hook-trust");
}

// Project config stub so the hooks know the tenant.
if (scope === "project") {
  const cfg = path.join(cwd, ".lakeday", "agent-skills.json");
  if (!fs.existsSync(cfg)) {
    writeJson(cfg, { tenant_id: process.env.LAKEDAY_TENANT_ID ?? "", project: path.basename(cwd).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") });
    console.log(`wrote ${cfg}; set tenant_id (or export LAKEDAY_TENANT_ID), then run lk login or set LAKEDAY_API_KEY`);
  }
}
console.log("hooks are inert until lk login (or a service credential) and a tenant are configured; set LAKEDAY_HOOK_DEBUG=1 to log to ~/.lakeday/agent-skills/hooks.log");
