import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveStepMcpEnvironment } from "./mcp.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("uses the logged-in Step credential only as a server env fallback", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "step-mcp-auth-"));
	roots.push(root);
	const authPath = path.join(root, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({ step: { type: "oauth", access: "login-key", refresh: "step-static-credential", expires: 1 } }),
	);

	const resolved = resolveStepMcpEnvironment(undefined, { env: { PATH: "/bin" }, authPath });
	expect(resolved.STEPFUN_API_KEY).toBe("login-key");
});

test("explicit declaration wins over both shell and login credentials", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "step-mcp-auth-"));
	roots.push(root);
	const authPath = path.join(root, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({ step: { type: "oauth", access: "login-key", refresh: "step-static-credential", expires: 1 } }),
	);

	const resolved = resolveStepMcpEnvironment(
		{ STEPFUN_API_KEY: "declared-key" },
		{ env: { PATH: "/bin", STEPFUN_API_KEY: "shell-key" }, authPath },
	);
	expect(resolved.STEPFUN_API_KEY).toBe("declared-key");
});
