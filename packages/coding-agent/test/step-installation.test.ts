import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { prepareStepInstallation } from "../src/step/installation.ts";
import { uninstallPlugin } from "../src/step/plugins.ts";
import { ensureStepPageReady } from "../src/step/steppage-provision.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executable(file: string, source: string) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, source);
	await chmod(file, 0o755);
}

const installerSource = `#!/bin/sh
set -eu
echo attempt >> "$HOME/installation-attempts"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nprintf "1.0.0\\\\n"\\n' > "$HOME/.local/bin/steppage-mcp"
chmod +x "$HOME/.local/bin/steppage-mcp"
`;

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "step-installation-"));
	roots.push(root);
	const bin = join(root, "fixture-bin");
	await executable(join(bin, "node"), '#!/bin/sh\nprintf "v24.0.0\\n"\n');
	await executable(
		join(bin, "curl"),
		'#!/bin/sh\ncase "$*" in *file://*) exec /usr/bin/curl "$@" ;; *) echo "test refuses network downloads" >&2; exit 1 ;; esac\n',
	);
	const installer = join(root, "installer.sh");
	await writeFile(installer, installerSource);
	const env: NodeJS.ProcessEnv = {
		HOME: root,
		PATH: `${bin}:/usr/bin:/bin`,
		SHELL: "/bin/zsh",
		STEPFUN_API_KEY: "fixture-credential",
		STEP_CODING_AGENT_DIR: join(root, ".stepcode", "agent"),
		STEPCODE_STEPPAGE_INSTALLER_URL: pathToFileURL(installer).href,
	};
	return { root, bin, installer, env, input: { env, executablePath: join(root, "step-bin", "step") } };
}

test.skipIf(process.platform === "win32")(
	"fresh installation waits for a verified executable and preserves credentials",
	async () => {
		const f = await fixture();
		await mkdir(join(f.root, ".stepcode"));
		await writeFile(join(f.root, ".stepcode", "auth.json"), '{"existing":"preserve"}');
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
		expect(await readFile(join(f.root, ".stepcode", "auth.json"), "utf8")).toBe('{"existing":"preserve"}');
		expect(await ensureStepPageReady({ env: f.env })).toMatchObject({
			command: join(f.root, ".local", "bin", "steppage-mcp"),
			installed: false,
		});
	},
);

test.skipIf(process.platform === "win32")("legacy markers do not prevent repair of a broken executable", async () => {
	const f = await fixture();
	expect(await prepareStepInstallation(f.input)).toEqual([]);
	await executable(
		join(f.root, ".local", "bin", "steppage-mcp"),
		'#!/bin/sh\necho "Cannot find module" >&2\nexit 1\n',
	);
	expect(await prepareStepInstallation(f.input)).toEqual([]);
	expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\nattempt\n");
	expect(await readFile(join(f.root, ".stepcode", "plugins", ".stepcode-preinstalled"), "utf8")).toBe(
		'["steppage"]\n',
	);
});

test.skipIf(process.platform === "win32")(
	"failed setup is a warning and retries despite an existing marker",
	async () => {
		const f = await fixture();
		await writeFile(f.installer, '#!/bin/sh\necho "download failed" >&2\nexit 1\n');
		const warnings = await prepareStepInstallation(f.input);
		expect(warnings.join(" ")).toContain("StepPage is not ready");
		expect(warnings.join(" ")).toContain("Step remains usable");
		expect(warnings.join(" ")).toContain(
			`Install it with: curl -fsSL '${f.env.STEPCODE_STEPPAGE_INSTALLER_URL}' | sh, then restart Step.`,
		);
		expect(warnings.join(" ")).toContain("step mcp prepare, then restart Step");
		await writeFile(f.installer, installerSource);
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
	},
);

test.skipIf(process.platform === "win32")(
	"a failed installer download cannot be mistaken for successful setup",
	async () => {
		const f = await fixture();
		f.env.STEPCODE_STEPPAGE_INSTALLER_URL = pathToFileURL(join(f.root, "missing.sh")).href;
		expect((await ensureStepPageReady({ env: f.env })).error).toContain("StepPage is not ready");
		await expect(readFile(join(f.root, "installation-attempts"))).rejects.toMatchObject({ code: "ENOENT" });
	},
);

test.skipIf(process.platform === "win32")(
	"healthy managed executables work outside PATH without downloading again",
	async () => {
		const f = await fixture();
		const command = join(f.root, ".local", "bin", "steppage-mcp");
		await executable(command, '#!/bin/sh\nprintf "1.0.0\\n"\n');
		f.env.STEPCODE_STEPPAGE_INSTALLER_URL = "file:///missing-installer.sh";
		expect(await ensureStepPageReady({ env: f.env })).toEqual({ command, installed: false });
	},
);

test.skipIf(process.platform === "win32")(
	"concurrent repairs download once and reuse the completed executable",
	async () => {
		const f = await fixture();
		await writeFile(f.installer, installerSource.replace("set -eu", "set -eu\nsleep 0.2"));
		const results = await Promise.all([ensureStepPageReady({ env: f.env }), ensureStepPageReady({ env: f.env })]);
		expect(results.every((result) => result.command && !result.error)).toBe(true);
		expect(results.filter((result) => result.installed)).toHaveLength(1);
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
	},
);

test.skipIf(process.platform === "win32")("missing and old Node versions leave setup retryable", async () => {
	const f = await fixture();
	await rm(join(f.bin, "node"));
	f.env.PATH = f.bin;
	expect((await ensureStepPageReady({ env: f.env })).error).toContain("Node.js >= 20");
	await executable(join(f.bin, "node"), '#!/bin/sh\nprintf "v18.0.0\\n"\n');
	expect((await ensureStepPageReady({ env: f.env })).error).toContain("found v18.0.0");
	await expect(readFile(join(f.root, "installation-attempts"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform === "win32")(
	"explicit uninstall stays uninstalled across setup and upgrade preparation",
	async () => {
		const f = await fixture();
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		await uninstallPlugin(join(f.root, ".stepcode", "plugins"), "steppage");
		await rm(join(f.root, ".local", "bin", "steppage-mcp"));
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		await expect(
			readFile(join(f.root, ".stepcode", "plugins", "steppage", "step.plugin.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
	},
);

test.skipIf(process.platform === "win32")(
	"customized plugin commands are preserved and never provisioned",
	async () => {
		const f = await fixture();
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		const path = join(f.root, ".stepcode", "plugins", "steppage", "step.plugin.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		manifest.mcpServers.steppage.command = "/custom/steppage";
		const custom = JSON.stringify(manifest);
		await writeFile(path, custom);
		await rm(join(f.root, ".local", "bin", "steppage-mcp"));
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		expect(await readFile(path, "utf8")).toBe(custom);
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
	},
);

test.skipIf(process.platform === "win32")(
	"explicit global disabling prevents automatic executable installation",
	async () => {
		const f = await fixture();
		await mkdir(join(f.root, ".stepcode"));
		await writeFile(join(f.root, ".stepcode", "config.toml"), "[mcp_servers.steppage__steppage]\nenabled = false\n");
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		await expect(readFile(join(f.root, "installation-attempts"))).rejects.toMatchObject({ code: "ENOENT" });
	},
);

test("an already cancelled readiness check never starts installation", async () => {
	const f = await fixture();
	const controller = new AbortController();
	controller.abort(new Error("cancelled session"));
	await expect(ensureStepPageReady({ env: f.env, signal: controller.signal })).rejects.toThrow("cancelled session");
});

test.skipIf(process.platform === "win32")(
	"legacy global default commands are repaired without rewriting their configuration",
	async () => {
		const f = await fixture();
		await mkdir(join(f.root, ".stepcode"));
		const configPath = join(f.root, ".stepcode", "config.toml");
		const config = '[mcp_servers.steppage__steppage]\ncommand = "steppage-mcp"\nstartup_timeout_sec = 30\n';
		await writeFile(configPath, config);
		expect(await prepareStepInstallation(f.input)).toEqual([]);
		expect(await readFile(join(f.root, "installation-attempts"), "utf8")).toBe("attempt\n");
		expect(await readFile(configPath, "utf8")).toBe(config);
	},
);

test
	.skipIf(process.platform === "win32")
	.each([
		'command = "/custom/steppage-mcp"\n',
		'command = "steppage-mcp"\nargs = ["--custom"]\n',
		'url = "https://example.test/mcp"\n',
	])("custom global declarations stay self-managed: %s", async (declaration) => {
	const f = await fixture();
	await mkdir(join(f.root, ".stepcode"));
	const configPath = join(f.root, ".stepcode", "config.toml");
	const config = `[mcp_servers.steppage__steppage]\n${declaration}`;
	await writeFile(configPath, config);
	expect(await prepareStepInstallation(f.input)).toEqual([]);
	await expect(readFile(join(f.root, "installation-attempts"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(configPath, "utf8")).toBe(config);
});

test.skipIf(process.platform === "win32")(
	"cancelling setup stops installer children and leaves the lock reusable",
	async () => {
		const f = await fixture();
		await writeFile(
			f.installer,
			`#!/bin/sh
(sleep 0.3; echo late > "$HOME/late-write") &
echo started > "$HOME/started"
wait
`,
		);
		const controller = new AbortController();
		const readiness = ensureStepPageReady({ env: f.env, signal: controller.signal });
		// Register rejection handling before cancellation.
		const rejected = expect(readiness).rejects.toThrow("cancelled session");
		await vi.waitFor(async () => expect(await readFile(join(f.root, "started"), "utf8")).toBe("started\n"));
		controller.abort(new Error("cancelled session"));
		await rejected;
		await delay(400);
		await expect(readFile(join(f.root, "late-write"))).rejects.toMatchObject({ code: "ENOENT" });
		await writeFile(f.installer, installerSource);
		expect((await ensureStepPageReady({ env: f.env })).installed).toBe(true);
	},
);
