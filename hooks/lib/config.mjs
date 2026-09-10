// Configuration resolution for the Lakeday hook runtime.
//
// Precedence (highest first):
//   1. Environment: LAKEDAY_TENANT_ID, LAKEDAY_HOOKS=0 (disable), LAKEDAY_HOOK_DEBUG=1
//   2. Project file: <cwd>/.lakeday/agent-skills.json (walks up to the git root)
//   3. User file:    $LAKEDAY_HOME/agent-skills.json (default ~/.lakeday)
//
// No credential is configured here: Lakeday access happens through the MCP
// server with the client's own OAuth sign-in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function lakedayHome(env = process.env) {
  return env.LAKEDAY_HOME || path.join(os.homedir(), ".lakeday");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Finds <dir>/.lakeday/agent-skills.json walking upward from cwd. */
export function findProjectConfig(cwd) {
  let dir = cwd ? path.resolve(cwd) : process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".lakeday", "agent-skills.json");
    if (fs.existsSync(candidate)) return { file: candidate, dir, data: readJson(candidate) ?? {} };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Derives a stable, identifier-safe project slug from the working directory. */
export function projectSlug(cwd) {
  const base = path.basename(path.resolve(cwd || process.cwd())) || "project";
  const slug = base.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return (slug || "project").slice(0, 60);
}

export function resolveConfig({ cwd, env = process.env } = {}) {
  const project = findProjectConfig(cwd);
  const user = readJson(path.join(lakedayHome(env), "agent-skills.json")) ?? {};
  const merged = { ...user, ...(project?.data ?? {}) };
  const tenant = env.LAKEDAY_TENANT_ID || merged.tenant_id || null;
  const slug = merged.project || projectSlug(project?.dir ?? cwd);
  // The hook needs no credential: the model talks to Lakeday through the MCP
  // server under the client's OAuth. Only a project identity is required, and
  // it is derived from the working directory when nothing is configured.
  const config = {
    enabled: merged.enabled !== false && env.LAKEDAY_HOOKS !== "0",
    tenant,
    home: lakedayHome(env),
    project: slug,
    enforceDecisions: merged.enforce_decisions !== false,
    maxStopBlocksPerTurn: Number.isInteger(merged.max_stop_blocks_per_turn) ? merged.max_stop_blocks_per_turn : 1,
    debug: env.LAKEDAY_HOOK_DEBUG === "1" || merged.debug === true,
    sourceFiles: { project: project?.file ?? null, user: path.join(lakedayHome(env), "agent-skills.json") },
  };
  if (!config.enabled) config.reason = "hooks disabled by configuration";
  return config;
}
