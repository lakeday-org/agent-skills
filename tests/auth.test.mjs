import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activate, login } from "../hooks/lakeday-hook.mjs";
import { cliAuthToken, discoverTenant, resolveToken } from "../hooks/lib/auth.mjs";
import { resolveConfig } from "../hooks/lib/config.mjs";

const BASE = "https://api.test";

function tempHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lakeday-auth-"));
}

function fakeMe({ deployments = ["acme-test"] } = {}) {
	const calls = [];
	async function fetch(input, init = {}) {
		const request = new Request(input, init);
		calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
		if (request.url === `${BASE}/v1/me`) {
			return Response.json({ organizations: [{ id: "org", deployments: deployments.map((id) => ({ id })) }] });
		}
		return Response.json({ error: "unhandled" }, { status: 404 });
	}
	return { fetch, calls };
}

test("resolveToken prefers an explicitly supplied service credential", async () => {
	let called = false;
	const result = await resolveToken({
		baseUrl: BASE,
		home: tempHome(),
		env: { LAKEDAY_API_KEY: "service-key" },
		execFile: async () => {
			called = true;
			return { stdout: "", stderr: "" };
		},
	});
	assert.deepEqual(result, { token: "service-key", source: "env" });
	assert.equal(called, false);
});

test("cliAuthToken calls the published CLI auth token interface", async () => {
	const calls = [];
	const result = await cliAuthToken({
		baseUrl: BASE,
		cwd: "/tmp/lakeday-project",
		env: { LAKEDAY_CLI_PATH: "/opt/lakeday/bin/lk", LAKEDAY_PROFILE: "team" },
		execFile: async (command, args, options) => {
			calls.push({ command, args, options });
			return { stdout: JSON.stringify({ type: "oauth", token: "cli-token" }), stderr: "" };
		},
	});
	assert.deepEqual(result, { token: "cli-token", source: "lk auth token" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "/opt/lakeday/bin/lk");
	assert.deepEqual(calls[0].args, ["auth", "token", "--json"]);
	assert.equal(calls[0].options.cwd, "/tmp/lakeday-project");
	assert.equal(calls[0].options.env.LAKEDAY_API_BASE_URL, BASE);
	assert.equal(calls[0].options.env.LAKEDAY_PROFILE, "team");
});

test("cliAuthToken accepts the API token response and rejects plain output", async () => {
	const apiToken = await cliAuthToken({
		baseUrl: BASE,
		execFile: async () => ({ stdout: JSON.stringify({ type: "api_token", token: "api-token" }), stderr: "" }),
	});
	assert.deepEqual(apiToken, { token: "api-token", source: "lk auth token" });

	const plain = await cliAuthToken({
		baseUrl: BASE,
		execFile: async () => ({ stdout: "unexpected-plain-token\n", stderr: "" }),
	});
	assert.equal(plain, null);
});

test("CLI failures and API-key-only output fail open without touching files", async () => {
	const logs = [];
	const home = tempHome();
	const credentialFile = path.join(home, "agent-skills", "credentials.json");
	fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
	fs.writeFileSync(credentialFile, JSON.stringify({ oauth_token: "legacy-file-token" }));
	const result = await resolveToken({
		baseUrl: BASE,
		home,
		env: {},
		log: (line) => logs.push(line),
		execFile: async () => ({ stdout: JSON.stringify({ type: "api_key", key: "key", email: "user@example.com" }), stderr: "" }),
	});
	assert.equal(result.token, null);
	assert.equal(result.source, "none");
	assert.equal(fs.readFileSync(credentialFile, "utf8").includes("legacy-file-token"), true);
	assert.ok(logs.some((line) => line.includes("API key/email pair")));

	const failed = await resolveToken({
		baseUrl: BASE,
		home,
		env: {},
		log: (line) => logs.push(line),
		execFile: async () => {
			const error = new Error("token=should-not-appear");
			error.code = "ENOENT";
			throw error;
		},
	});
	assert.match(failed.hint, /lk login/);
	assert.ok(logs.some((line) => line.includes("lk auth token failed (ENOENT)")));
	assert.equal(logs.some((line) => line.includes("should-not-appear")), false);
});

test("tenant discovery caches the only visible deployment", async () => {
	const home = tempHome();
	const kit = fakeMe();
	const tenant = await discoverTenant({ baseUrl: BASE, token: "access-token", home, fetch: kit.fetch });
	assert.equal(tenant, "acme-test");
	assert.equal(kit.calls[0].authorization, "Bearer access-token");

	const cached = await discoverTenant({ baseUrl: BASE, token: "access-token", home, fetch: () => { throw new Error("cache should serve"); } });
	assert.equal(cached, "acme-test");
	const switched = fakeMe();
	assert.equal(await discoverTenant({ baseUrl: BASE, token: "different-token", home, fetch: switched.fetch }), "acme-test");
	assert.equal(fs.readFileSync(path.join(home, "agent-skills", "cache", "tenants.json"), "utf8").includes("access-token"), false);

	const many = fakeMe({ deployments: ["a", "b"] });
	assert.equal(await discoverTenant({ baseUrl: BASE, token: "access-token", home: tempHome(), fetch: many.fetch }), null);
});

test("activate uses the CLI token and discovers a tenant", async () => {
	const home = tempHome();
	const kit = fakeMe();
	const env = { LAKEDAY_HOME: home, LAKEDAY_API_BASE_URL: BASE };
	const config = resolveConfig({ cwd: home, env });
	await activate(config, {
		env,
		cwd: home,
		fetch: kit.fetch,
		execFile: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "cli-token" }), stderr: "" }),
	});
	assert.equal(config.enabled, true);
	assert.equal(config.tenant, "acme-test");
	assert.equal(config.tokenSource, "lk auth token");

	const bare = resolveConfig({ cwd: tempHome(), env: { LAKEDAY_HOME: tempHome(), LAKEDAY_API_BASE_URL: BASE } });
	await activate(bare, { env: {}, execFile: async () => { throw new Error("missing lk"); }, fetch: kit.fetch });
	assert.equal(bare.enabled, false);
	assert.match(bare.reason, /no credential/);
});

test("hook login delegates to the installed CLI and preserves its exit code", async () => {
	const child = new EventEmitter();
	const calls = [];
	const errors = [];
	const result = login(["--browser=false"], {
		env: { LAKEDAY_CLI_PATH: "/opt/lakeday/bin/lk", LAKEDAY_API_BASE_URL: BASE },
		spawn: (command, args, options) => {
			calls.push({ command, args, options });
			queueMicrotask(() => child.emit("exit", 7));
			return child;
		},
		stderr: { write: (line) => errors.push(line) },
	});
	assert.equal(await result, 7);
	assert.deepEqual(calls[0].args, ["login", "--browser=false"]);
	assert.equal(calls[0].command, "/opt/lakeday/bin/lk");
	assert.equal(calls[0].options.stdio, "inherit");
	assert.equal(calls[0].options.env.LAKEDAY_API_BASE_URL, BASE);
	assert.deepEqual(errors, []);
});
