// Configuration resolution for the Lakeday hook runtime.
//
// Precedence (highest first):
//   1. Environment: LAKEDAY_TENANT_ID, LAKEDAY_API_BASE_URL (and an optional
//      LAKEDAY_API_KEY for service identities; people sign in with OAuth, see auth.mjs)
//   2. Project file: <cwd>/.lakeday/agent-skills.json (walks up to the git root)
//   3. User file:    $LAKEDAY_HOME/agent-skills.json (default ~/.lakeday)
//
// The credential and, when unset, the tenant are resolved asynchronously by
// the hook entry (lk login or env). Hooks must never
// block the coding agent when Lakeday is unconfigured.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_BASE_URL = "https://api.lakeday.ai";

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

  const token = env.LAKEDAY_API_KEY || env.LAKEDAY_API_TOKEN || env.LAKEDAY_TOKEN || null;
  const tenant = env.LAKEDAY_TENANT_ID || merged.tenant_id || null;
  const baseUrl = (env.LAKEDAY_API_BASE_URL || merged.api_base_url || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const slug = merged.project || projectSlug(project?.dir ?? cwd);

  const config = {
    // Finalized by the entry point once OAuth and tenant discovery ran.
    enabled: false,
    token,
    tenant,
    baseUrl,
    home: lakedayHome(env),
    project: slug,
    // Entity IDs the hooks maintain. Personal IDs are prefixed with the caller's
    // OS owner prefix at runtime; shared IDs are used verbatim and require
    // collection grants on the deployment's Entity Worker.
    projectEntity: merged.project_entity || `repo:${slug}`,
    sharedEntities: merged.shared_entities === true,
    // ALWAYS policy knobs.
    enforceDecisions: merged.enforce_decisions !== false,
    maxStopBlocksPerTurn: Number.isInteger(merged.max_stop_blocks_per_turn) ? merged.max_stop_blocks_per_turn : 1,
    contextBudgetChars: Number.isInteger(merged.context_budget_chars) ? merged.context_budget_chars : 16000,
    recallPriorDecisions: merged.recall_prior_decisions !== false,
    debug: env.LAKEDAY_HOOK_DEBUG === "1" || merged.debug === true,
    sourceFiles: { project: project?.file ?? null, user: path.join(lakedayHome(env), "agent-skills.json") },
  };
  return config;
}
