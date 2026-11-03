import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes private dependencies without touching registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/providers", {
			name: "@step-harness/providers",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@step-harness/coding-agent",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/contracts", {
			name: "@step-harness/contracts",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@step-harness/coding-agent": "^1.0.0",
				"@mariozechner/pi-ai": "npm:@step-harness/providers@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@step-harness/coding-agent": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const contractsManifest = await readManifest(root, "packages/contracts");
		assert.equal(contractsManifest.dependencies["@step-harness/coding-agent"], "^2.0.0");
		assert.equal(contractsManifest.dependencies["@mariozechner/pi-ai"], "npm:@step-harness/providers@1.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@step-harness/coding-agent"], "^1.0.0");

		await writeManifest(root, "packages/providers", {
			name: "@step-harness/providers",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
