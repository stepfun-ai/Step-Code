import { describe, expect, test, vi } from "vitest";
import { parseStepUpdateCommand } from "../src/step/command-compat.ts";
import { normalizeStepStableVersion, runStepUpdateCommand } from "../src/step/local-update.ts";

describe("Step update command", () => {
	test.each([
		["update", { command: "update" }],
		["update 0.4.0", { command: "update", version: "0.4.0" }],
		["upgrade", { command: "upgrade" }],
		["upgrade v0.4.0", { command: "upgrade", version: "0.4.0" }],
	])("parses %s", (input, expected) => {
		expect(parseStepUpdateCommand(input.split(" "))).toEqual(expected);
	});

	test.each(["update --self", "update --all", "update --extensions", "upgrade --force", "update 0.4.0 extra"])(
		"rejects unsupported form %s",
		(input) => {
			const parsed = parseStepUpdateCommand(input.split(" "));
			expect(parsed).toEqual(expect.objectContaining({ error: expect.any(String) }));
		},
	);

	test("accepts release tag prefixes for exact versions", () => {
		expect(normalizeStepStableVersion("refs/tags/step-v0.4.0")).toBe("0.4.0");
		expect(normalizeStepStableVersion("0.4.0-beta.1")).toBeNull();
	});

	test("rejects a non-standalone invocation before contacting the release service", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const exitCode = await runStepUpdateCommand({ executablePath: "/tmp/step-source-entrypoint", fetchImpl });
		expect(exitCode).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test.skipIf(process.platform === "win32").each([0, 7])(
		"runs the new binary's preparation after upgrade and keeps Step when optional setup exits %s",
		async (setupExitCode) => {
			const root = await mkdtemp(join(tmpdir(), "step-upgrade-prepare-"));
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			try {
				const release = join(root, "release");
				const installed = join(root, "installed");
				await mkdir(release);
				await mkdir(installed);
				const executablePath = join(installed, "step");
				await writeFile(executablePath, "#!/bin/sh\nexit 99\n");
				const binary = join(release, "step");
				await writeFile(
					binary,
					`#!/bin/sh
case "$*" in
  --version) printf '0.4.0\\n' ;;
  "mcp prepare") printf '%s\\n' "$*" > "$HOME/prepared"; exit ${setupExitCode} ;;
  *) exit 99 ;;
esac
`,
				);
				await chmod(binary, 0o755);
				const archivePath = join(root, "release.tar.gz");
				expect(spawnSync("tar", ["-czf", archivePath, "-C", root, "release"]).status).toBe(0);
				const archive = await readFile(archivePath);
				const target = `${process.platform}-${process.arch}`;
				const url = "https://releases.example.test/release.tar.gz";
				const manifest = {
					version: "0.4.0",
					packages: { [target]: url },
					checksums: { [target]: createHash("sha256").update(archive).digest("hex") },
				};
				const fetchImpl = vi
					.fn<typeof fetch>()
					.mockImplementation(async (input) =>
						String(input) === url ? new Response(archive) : Response.json(manifest),
					);
				expect(
					await runStepUpdateCommand({
						version: "0.4.0",
						executablePath,
						env: { HOME: root, PATH: "/usr/bin:/bin" },
						fetchImpl,
					}),
				).toBe(0);
				expect(await readFile(join(root, "prepared"), "utf8")).toBe("mcp prepare\n");
				expect(await readFile(executablePath, "utf8")).toContain("0.4.0");
				if (setupExitCode) expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Step remains usable"));
			} finally {
				stderr.mockRestore();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
