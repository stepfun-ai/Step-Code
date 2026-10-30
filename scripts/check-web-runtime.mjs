#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), "stepcode-web-runtime-cwd-"));
const agentDir = await mkdtemp(join(tmpdir(), "stepcode-web-runtime-agent-"));
const port = 3187;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["apps/web/dist/server.js"], {
	cwd: root,
	env: {
		...process.env,
		STEPCODE_WEB_PORT: String(port),
		STEPCODE_WEB_CWD: cwd,
		STEP_CODING_AGENT_DIR: agentDir,
		STEPCODE_AUTH_PATH: join(agentDir, "auth.json"),
		STEPCODE_LEGACY_AUTH_PATH: join(agentDir, "legacy-auth.json"),
		// A check must never open a window, even when the caller exported the flag.
		STEPCODE_WEB_OPEN: "0",
		// HOME is the caller's: never copy a local stepgo key into the temporary config root.
		STEPCODE_STEPGO_IMPORT: "0",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	output += chunk;
});
child.stderr.on("data", (chunk) => {
	output += chunk;
});

async function waitForServer() {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const match = /#token=([A-Za-z0-9_-]+)/u.exec(output);
		if (match) return match[1];
		if (child.exitCode !== null) throw new Error(`Web server exited early: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Web server did not start: ${output}`);
}

async function request(path, init = {}, cookie) {
	const response = await fetch(`${origin}${path}`, {
		...init,
		headers: {
			...(init.headers ?? {}),
			...(cookie ? { cookie } : {}),
			...(path.startsWith("/api/") ? { origin } : {}),
		},
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`);
	return { response, body };
}

try {
	await writeFile(join(cwd, "smoke.txt"), "stepcode web smoke\n", "utf8");
	const authPath = join(agentDir, "auth.json");
	const loginStatePath = join(agentDir, "step-login.json");
	await writeFile(
		authPath,
		`${JSON.stringify({
			step: {
				type: "oauth",
				access: "smoke-key",
				refresh: "step-static-credential",
				expires: Number.MAX_SAFE_INTEGER,
				profile: "step_plan",
			},
		})}\n`,
		"utf8",
	);
	await writeFile(
		loginStatePath,
		`${JSON.stringify({
			version: 1,
			profile: "step_plan",
			appId: "10300",
			deviceId: "smoke-device",
			accessToken: "smoke-access",
			refreshToken: "smoke-refresh",
			accessExpiresAt: Math.floor(Date.now() / 1000) + 1800,
		})}\n`,
		"utf8",
	);
	const token = await waitForServer();
	const auth = await fetch(`${origin}/auth/exchange`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (!auth.ok) throw new Error(`Auth exchange failed: ${auth.status}`);
	const setCookie = auth.headers.get("set-cookie");
	if (!setCookie) throw new Error("Auth exchange did not set a cookie");
	const cookie = setCookie.split(";", 1)[0];

	const health = await request("/healthz");
	if (health.body?.ok !== true) throw new Error("healthz failed");
	// The embedded browser's Web iframe must never be able to show the Host itself.
	const page = await request("/", {}, cookie);
	for (const response of [health.response, page.response]) {
		if (response.headers.get("content-security-policy") !== "frame-ancestors 'none'")
			throw new Error("Host responses must refuse framing (frame-ancestors 'none')");
		if (response.headers.get("x-frame-options") !== "DENY") throw new Error("Host responses must send X-Frame-Options: DENY");
	}
	const created = await request("/api/v1/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	}, cookie);
	const sessionId = created.body.id;
	if (!sessionId || !String(created.body.sessionFile).endsWith(".jsonl")) {
		throw new Error("new session is not backed by a v3 JSONL file");
	}

	const firstSnapshot = await request(`/api/v1/sessions/${sessionId}`, {}, cookie);
	if (!["ask", "approve-for-me", "full-access"].includes(firstSnapshot.body.permissionPreset)) {
		throw new Error("unexpected permission policy");
	}
	const policy = await request(`/api/v1/sessions/${sessionId}/policy`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ preset: "approve-for-me" }),
	}, cookie);
	if (policy.body.permissionPreset !== "approve-for-me") throw new Error("policy did not persist");

	const renamed = await request(`/api/v1/sessions/${sessionId}/name`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Runtime smoke" }),
	}, cookie);
	if (renamed.body.name !== "Runtime smoke") throw new Error("rename failed");
	const archived = await request(`/api/v1/sessions/${sessionId}/archive`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ archived: true }),
	}, cookie);
	if (archived.body.archived !== true) throw new Error("archive failed");

	const files = await request(`/api/v1/sessions/${sessionId}/files`, {}, cookie);
	if (!files.body.files.some((entry) => entry.path === "smoke.txt")) throw new Error("file tree did not expose cwd file");
	const directories = await request(`/api/v1/directories?path=${encodeURIComponent(tmpdir())}`, {}, cookie);
	if (directories.body.path !== (await realpath(tmpdir())) || !Array.isArray(directories.body.directories)) {
		throw new Error("directory browser did not expose the requested folder");
	}
	const file = await request(`/api/v1/sessions/${sessionId}/file?path=smoke.txt`, {}, cookie);
	if (file.body.content !== "stepcode web smoke\n") throw new Error("file read failed");

	const streamResponse = await fetch(`${origin}/api/v1/sessions/${sessionId}/events`, {
		headers: { origin, cookie },
	});
	if (!streamResponse.ok || !streamResponse.body) throw new Error("SSE connection failed");
	const reader = streamResponse.body.getReader();
	const firstChunk = new TextDecoder().decode((await reader.read()).value);
	await reader.cancel();
	if (!firstChunk.includes("event: snapshot")) throw new Error("SSE did not emit a snapshot");

	for (let index = 0; index < 50; index += 1) {
		await request(`/api/v1/sessions/${sessionId}`, {}, cookie);
	}
	const deleted = await request(`/api/v1/sessions/${sessionId}`, { method: "DELETE" }, cookie);
	if (deleted.body?.ok !== true) throw new Error("delete failed");
	const afterDelete = await fetch(`${origin}/api/v1/sessions/${sessionId}`, {
		headers: { origin, cookie },
	});
	if (afterDelete.status !== 404) throw new Error(`deleted session still available: ${afterDelete.status}`);
	const stepLogout = await request("/api/v1/logout", { method: "POST" }, cookie);
	if (stepLogout.body?.removed !== true || stepLogout.body?.accountSessionRemoved !== true) {
		throw new Error(`Step logout did not report removal: ${JSON.stringify(stepLogout.body)}`);
	}
	if (stepLogout.body?.login?.configured !== false) throw new Error("Step logout left a configured credential");
	const stored = JSON.parse(await readFile(authPath, "utf8"));
	if ("step" in stored) throw new Error("Step logout left the step credential in auth.json");
	if (existsSync(loginStatePath)) throw new Error("Step logout left step-login.json");
	const logout = await fetch(`${origin}/auth/logout`, {
		method: "POST",
		headers: { origin, cookie },
	});
	if (!logout.ok || !logout.headers.get("set-cookie")?.includes("Max-Age=0")) {
		throw new Error("logout did not expire the authentication cookie");
	}
	console.log("web runtime smoke passed: step logout, auth/logout, v3 session, policy, rename, archive, files/directories, SSE, 50 reads");
} finally {
	if (child.exitCode === null) {
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGTERM");
		// A server that ignores SIGTERM must not hang the pre-commit hook.
		const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
		await exited;
		clearTimeout(forceKill);
	}
	await rm(cwd, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
}
