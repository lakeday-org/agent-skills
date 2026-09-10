#!/usr/bin/env node
// Repository checks: every skill has valid frontmatter and matches catalog.json,
// references exist, depends_on resolve, manifests share one version, hook
// configs parse, and plugin output is in sync with sources.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (msg) => errors.push(msg);

const skillsDir = path.join(root, "skills");
const catalog = JSON.parse(fs.readFileSync(path.join(skillsDir, "catalog.json"), "utf8"));
const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const LAYERS = new Set(["utility", "workflow", "use-case"]);

for (const name of dirs) {
  const file = path.join(skillsDir, name, "SKILL.md");
  if (!fs.existsSync(file)) { fail(`${name}: missing SKILL.md`); continue; }
  const text = fs.readFileSync(file, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) { fail(`${name}: missing frontmatter`); continue; }
  const fields = Object.fromEntries(fm[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
  if (fields.name !== name) fail(`${name}: frontmatter name "${fields.name}" != directory`);
  if (!fields.description || fields.description.length < 40) fail(`${name}: description too short`);
  if (fields.description && fields.description.length > 1024) fail(`${name}: description over 1024 chars`);
  if (!fields.license) fail(`${name}: missing license`);
  const entry = catalog[name];
  if (!entry) { fail(`${name}: not in catalog.json`); continue; }
  if (entry.name !== name) fail(`${name}: catalog name mismatch`);
  if (entry.description !== fields.description) fail(`${name}: catalog description differs from frontmatter`);
  if (!LAYERS.has(entry.layer)) fail(`${name}: unknown layer ${entry.layer}`);
  for (const dep of entry.depends_on ?? []) if (!catalog[dep]) fail(`${name}: depends_on unknown skill ${dep}`);
  for (const ref of entry.references ?? []) if (!fs.existsSync(path.join(skillsDir, name, ref))) fail(`${name}: missing reference ${ref}`);
  const refDir = path.join(skillsDir, name, "references");
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) if (!(entry.references ?? []).includes(`references/${f}`)) fail(`${name}: references/${f} not listed in catalog`);
  }
  if (!/### Related Skills/.test(text)) fail(`${name}: missing "Related Skills" section`);
  for (const m of text.matchAll(/`(lakeday-[a-z-]+)`/g)) {
    if (m[1] !== name && !catalog[m[1]] && !["lakeday-skills", "lakeday-hook", "lakeday-org"].includes(m[1])) fail(`${name}: mentions unknown skill ${m[1]}`);
  }
}
for (const name of Object.keys(catalog)) if (!dirs.includes(name)) fail(`catalog lists ${name} but skills/${name} does not exist`);

// Manifest versions.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!pkg.dependencies?.["@lakeday-org/worker-js"]) {
  fail("package.json must declare @lakeday-org/worker-js as a runtime dependency");
}
if (fs.existsSync(path.join(root, "hooks", "lib", "learning.mjs"))) {
  fail("hooks/lib/learning.mjs is a retired vendored copy; import @lakeday-org/worker-js/learning directly");
}
const versions = {
  marketplace: JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8")).metadata.version,
  codex: JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8")).version,
  cursor: JSON.parse(fs.readFileSync(path.join(root, ".cursor-plugin/plugin.json"), "utf8")).version,
};
for (const [k, v] of Object.entries(versions)) if (v !== pkg.version) fail(`${k} manifest version ${v} != package ${pkg.version}`);

// Hook configs.
const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8"));
for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "SessionEnd"]) {
  if (!hooks.hooks[event]) fail(`hooks.json missing ${event}`);
}
const cursor = JSON.parse(fs.readFileSync(path.join(root, "hooks/cursor.hooks.json"), "utf8"));
if (cursor.version !== 1) fail("cursor.hooks.json must declare version 1");

// Plugin output in sync.
let hookBuildMarker;
try {
  const learningSource = fileURLToPath(import.meta.resolve("@lakeday-org/worker-js/learning"));
  const hookSourceFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) hookSourceFiles.push(file);
    }
  };
  collect(path.join(root, "hooks"));
  const digest = createHash("sha256")
    .update(fs.readFileSync(learningSource))
    .update("\0")
    .update(hookSourceFiles.sort().map((file) => `${path.relative(root, file)}\0${fs.readFileSync(file)}`).join("\0"))
    .digest("hex")
    .slice(0, 16);
  hookBuildMarker = `// GENERATED by scripts/build-plugins.mjs; hook sources ${digest}`;
} catch {
  fail("@lakeday-org/worker-js/learning is not installed; run npm install before validating plugins");
}
for (const plugin of ["lakeday-skills-claude", "lakeday-skills-codex", "lakeday-skills-cursor"]) {
  const dir = path.join(root, "plugins", plugin);
  if (!fs.existsSync(dir)) { fail(`plugins/${plugin} missing; run npm run build`); continue; }
  for (const name of dirs) {
    const a = fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const bFile = path.join(dir, "skills", name, "SKILL.md");
    if (!fs.existsSync(bFile) || fs.readFileSync(bFile, "utf8") !== a) fail(`plugins/${plugin}/skills/${name} out of date; run npm run build`);
  }
  const hookB = path.join(dir, "hooks/lakeday-hook.mjs");
  if (!fs.existsSync(hookB)) {
    fail(`plugins/${plugin}/hooks/lakeday-hook.mjs missing; run npm run build`);
  } else {
    const generated = fs.readFileSync(hookB, "utf8");
    if (hookBuildMarker && !generated.includes(hookBuildMarker)) fail(`plugins/${plugin}/hooks/lakeday-hook.mjs out of date; run npm run build`);
    if (generated.includes("hooks/lib/learning.mjs")) fail(`plugins/${plugin}/hooks/lakeday-hook.mjs still references a vendored learning copy; run npm run build`);
    if (fs.existsSync(path.join(dir, "hooks", "lib"))) fail(`plugins/${plugin}/hooks/lib is a retired vendored hook tree; run npm run build`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✖ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`✔ ${dirs.length} skills, manifests at ${pkg.version}, hooks and plugins in sync`);
