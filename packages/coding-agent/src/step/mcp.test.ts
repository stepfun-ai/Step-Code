import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { appendStepPageManagementHint, describeMcpStartFailure, resolveStepMcpEnvironment } from "./mcp.ts";

const roots: string[] = [];

test.each([
	new StreamableHTTPError(401, "Error POSTing to endpoint: Unauthorized"),
	new StreamableHTTPError(401, "Credentials expired"),
	new UnauthorizedError(),
])("authentication failures include the server login command: %s", (error) => {
	const message = describeMcpStartFailure({
		name: "figma",
		command: "https://example.test/mcp",
		error,
	});
	expect(message).toContain(error.message);
	expect(message).toContain("Authenticate with: step mcp login figma, then restart Step.");
});

test("HTTP permission failures do not suggest login", () => {
	const error = new StreamableHTTPError(403, "Insufficient permissions");
	expect(
		describeMcpStartFailure({
			name: "figma",
			command: "https://example.test/mcp",
			error,
		}),
	).toBe(`MCP server 'figma' could not start: ${error.message}`);
});

test("login guidance quotes server names containing shell syntax", () => {
	const message = describeMcpStartFailure({
		name: "team's mcp",
		command: "https://example.test/mcp",
		error: new UnauthorizedError(),
	});
	expect(message).toContain("step mcp login 'team'\\''s mcp'");
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("uses the logged-in Step credential only as a server env fallback", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "step-mcp-auth-"));
	roots.push(root);
	const authPath = path.join(root, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({
			step: {
				type: "oauth",
				access: "login-key",
				refresh: "step-static-credential",
				expires: 1,
			},
		}),
	);

	const resolved = resolveStepMcpEnvironment(undefined, {
		env: { PATH: "/bin" },
		authPath,
	});
	expect(resolved.STEPFUN_API_KEY).toBe("login-key");
});

test("explicit declaration wins over both shell and login credentials", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "step-mcp-auth-"));
	roots.push(root);
	const authPath = path.join(root, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({
			step: {
				type: "oauth",
				access: "login-key",
				refresh: "step-static-credential",
				expires: 1,
			},
		}),
	);

	const resolved = resolveStepMcpEnvironment(
		{ STEPFUN_API_KEY: "declared-key" },
		{ env: { PATH: "/bin", STEPFUN_API_KEY: "shell-key" }, authPath },
	);
	expect(resolved.STEPFUN_API_KEY).toBe("declared-key");
});

test("adds the StepPage management link only to successful page deployments", () => {
	const deployment = appendStepPageManagementHint(
		"steppage__steppage",
		"page_deploy",
		"Preview: https://example.test",
	);
	expect(deployment).toContain("To manage your deployed pages, visit https://platform.stepfun.com/sites");
	expect(appendStepPageManagementHint("steppage__steppage", "page_list", "sites")).toBe("sites");
	expect(appendStepPageManagementHint("other__server", "page_deploy", "result")).toBe("result");
});

test("a missing executable is reported with the installer command instead of a raw ENOENT", () => {
	const message = describeMcpStartFailure({
		name: "steppage__steppage",
		command: "steppage-mcp",
		provision: { command: "steppage-mcp", installer: "steppageInstaller" },
		error: Object.assign(new Error("spawn steppage-mcp ENOENT"), {
			code: "ENOENT",
		}),
		env: {},
	});

	expect(message).toContain("'steppage-mcp' is not installed or not on PATH");
	expect(message).toContain("curl -fsSL 'https://dl.stepfun.com/steppage-mcp/p/install.sh' | sh");
	expect(message).toContain("restart Step");
	expect(message).not.toContain("ENOENT");
});

test("the installer override is honoured in the guidance", () => {
	const message = describeMcpStartFailure({
		name: "steppage__steppage",
		command: "steppage-mcp",
		provision: { command: "steppage-mcp", installer: "steppageInstaller" },
		error: Object.assign(new Error("spawn steppage-mcp ENOENT"), {
			code: "ENOENT",
		}),
		env: { STEPCODE_STEPPAGE_INSTALLER_URL: "https://example.test/install.sh" },
	});

	expect(message).toContain("curl -fsSL 'https://example.test/install.sh' | sh");
});

test("a missing executable without a provisionable installer still names the command", () => {
	const message = describeMcpStartFailure({
		name: "playwright__playwright",
		command: "npx",
		error: Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }),
		env: {},
	});

	expect(message).toContain("'npx' is not installed or not on PATH");
	expect(message).not.toContain("curl -fsSL");
});

test("failures that are not a missing executable keep the underlying error", () => {
	const message = describeMcpStartFailure({
		name: "steppage__steppage",
		command: "steppage-mcp",
		provision: { command: "steppage-mcp", installer: "steppageInstaller" },
		error: new Error("Request timed out"),
		env: {},
	});

	expect(message).toBe("MCP server 'steppage__steppage' could not start: Request timed out");
});
