import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));

it.each([
	{ runtime: "Node", electron: false, runAsNode: undefined, expected: ["step"] },
	{ runtime: "Node with an inherited Electron flag", electron: false, runAsNode: "1", expected: ["step"] },
	{ runtime: "Electron Node-mode child", electron: true, runAsNode: "1", expected: [] },
])("$runtime preserves its process-title policy through the real CLI startup", ({ electron, runAsNode, expected }) => {
	const root = mkdtempSync(join(tmpdir(), "step-process-title-"));
	try {
		const report = join(root, "title.json");
		const preload = join(root, "title.cjs");
		// Observe assignments rather than the final name: restoring process.title
		// after setting it would already have registered a macOS foreground app.
		writeFileSync(preload, `
			const titles = [];
			let title = process.title;
			Object.defineProperty(process, "title", {
				get: () => title,
				set: value => { titles.push(value); title = value; },
			});
			${electron ? 'Object.defineProperty(process.versions, "electron", { value: "44.7.0" });' : ""}
			process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(titles)));
		`);
		const result = spawnSync(process.execPath, ["--require", preload, "--import", import.meta.resolve("tsx"), cli, "--version"], {
			cwd: root,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: root,
				USERPROFILE: root,
				TMPDIR: root,
				TMP: root,
				TEMP: root,
				TSX_TSCONFIG_PATH: tsconfig,
				STEP_CODING_AGENT_DIR: join(root, "agent"),
				STEPCODE_AUTH_PATH: join(root, "auth.json"),
				STEPCODE_LEGACY_AUTH_PATH: join(root, "legacy-auth.json"),
				STEPCODE_DISABLE_PI_SERVICES: "1",
				STEP_NO_LOCAL_LLM: "1",
				AWS_EC2_METADATA_DISABLED: "true",
				ELECTRON_RUN_AS_NODE: runAsNode,
			},
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(JSON.parse(readFileSync(report, "utf8"))).toEqual(expected);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
