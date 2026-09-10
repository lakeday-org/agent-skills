// Bearer-token resolution for the hooks.
//
// Human authentication belongs to the Lakeday CLI. The hook asks `lk auth
// token --json` for the active token instead of reading or changing the CLI's
// credential store. Service identities may still provide LAKEDAY_API_KEY or
// LAKEDAY_API_TOKEN directly.
//
// Everything is fail-open: an unavailable CLI or invalid response resolves to
// null and the caller decides what to do.

import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);
const CLI_TIMEOUT_MS = 10_000;
const CLI_MAX_BUFFER = 256 * 1024;

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function cliPath(env) {
	return env.LAKEDAY_CLI_PATH || env.LAKEDAY_CLI || "lk";
}

function parseCliToken(stdout) {
	const text = String(stdout ?? "").trim();
	if (!text) return null;
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		(result?.type === "oauth" || result?.type === "api_token") &&
		typeof result.token === "string" &&
		result.token
	) {
		return result;
	}
	if (result?.type === "api_key") return { type: "api_key" };
	return null;
}

export function safeErrorCode(error) {
	const code = error?.code;
	if (Number.isInteger(code)) return `exit ${code}`;
	if (
		typeof code === "string" &&
		["ENOENT", "EACCES", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(code)
	) {
		return code;
	}
	if (typeof error?.signal === "string" && /^SIG[A-Z0-9]+$/.test(error.signal)) {
		return `signal ${error.signal}`;
	}
	return "unavailable";
}

/** Resolve a bearer token by asking the installed CLI for its active auth. */
export async function cliAuthToken({
	baseUrl,
	cwd = process.cwd(),
	env = process.env,
	execFile: execFileImpl = execFileAsync,
	log = () => {},
}) {
	const commandEnv = {
		...process.env,
		...env,
		LAKEDAY_API_BASE_URL: baseUrl,
	};
	try {
		const { stdout } = await execFileImpl(
			cliPath(env),
			["auth", "token", "--json"],
			{
				cwd,
				env: commandEnv,
				encoding: "utf8",
				timeout: CLI_TIMEOUT_MS,
				maxBuffer: CLI_MAX_BUFFER,
			}
		);
		const result = parseCliToken(stdout);
		if (result?.token) return { token: result.token, source: "lk auth token" };
		if (result?.type === "api_key") {
			log("lk auth token returned an API key/email pair; hooks need a bearer token");
		}
	} catch (error) {
		log(`lk auth token failed (${safeErrorCode(error)})`);
	}
	return null;
}

/**
 * Resolves a bearer token for `baseUrl`. Returns { token, source } or
 * { token: null, source, hint }.
 */
export async function resolveToken({
	baseUrl,
	home: _home,
	cwd = process.cwd(),
	env = process.env,
	execFile: execFileImpl = execFileAsync,
	log = () => {},
}) {
	const envToken = env.LAKEDAY_API_KEY || env.LAKEDAY_API_TOKEN || env.LAKEDAY_TOKEN;
	if (envToken) return { token: envToken, source: "env" };

	const fromCli = await cliAuthToken({
		baseUrl,
		cwd,
		env,
		execFile: execFileImpl,
		log,
	});
	if (fromCli) return fromCli;
	return {
		token: null,
		source: "none",
		hint: "run `lk login` first, or set LAKEDAY_API_KEY for a service identity",
	};
}

function tokenFingerprint(token) {
	return createHash("sha256").update(String(token)).digest("hex").slice(0, 32);
}

/** Picks the tenant when none is configured: the only deployment the user can see. */
export async function discoverTenant({
	baseUrl,
	token,
	home,
	fetch: fetchImpl = globalThis.fetch,
	log = () => {},
}) {
	const cacheFile = path.join(home, "agent-skills", "cache", "tenants.json");
	const cache = readJson(cacheFile) ?? {};
	const cacheKey = `${baseUrl}#${tokenFingerprint(token)}`;
	if (
		cache[cacheKey]?.tenant &&
		Date.now() - (cache[cacheKey].at ?? 0) < 24 * 3600 * 1000
	) {
		return cache[cacheKey].tenant;
	}
	const response = await fetchImpl(`${baseUrl}/v1/me`, {
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
	});
	if (!response.ok) {
		log(`/v1/me failed: HTTP ${response.status}`);
		return null;
	}
	const me = await response.json();
	const deployments = [];
	for (const organization of Array.isArray(me.organizations) ? me.organizations : []) {
		for (const deployment of Array.isArray(organization?.deployments)
			? organization.deployments
			: []) {
			if (deployment && typeof deployment.id === "string") deployments.push(deployment.id);
		}
	}
	if (deployments.length !== 1) {
		log(`tenant discovery: ${deployments.length} deployments visible; set tenant_id`);
		return null;
	}
	cache[cacheKey] = { tenant: deployments[0], at: Date.now() };
	writeJson(cacheFile, cache);
	return deployments[0];
}
