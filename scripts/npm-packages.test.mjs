import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createMainManifest,
	NPM_MAIN_PACKAGE,
	NPM_TARGETS,
	npmrcAuthLine,
	platformPackageName,
	stagePackages,
} from "../infra/release/npm-packages.mjs";

const VERSION = "1.2.3";

function commandAvailable(command, ...args) {
	return !spawnSync(command, args, { stdio: "ignore" }).error;
}

// A fake `step` binary: prints its argv and the install-method marker, then
// exits with the code passed as the first argument.
const FAKE_STEP = '#!/bin/sh\necho "args=$* method=$STEPCODE_INSTALL_METHOD"\nexit "${1:-0}"\n';

async function writeFakeRelease(root) {
	const archivesDir = join(root, "archives");
	await mkdir(archivesDir, { recursive: true });
	const packages = {};
	const checksums = {};
	for (const target of NPM_TARGETS) {
		const contentDir = join(root, "content", target.id, "step");
		await mkdir(join(contentDir, "theme"), { recursive: true });
		await writeFile(join(contentDir, target.binary), FAKE_STEP);
		await chmod(join(contentDir, target.binary), 0o755);
		await writeFile(join(contentDir, "package.json"), '{"name":"embedded-runtime-manifest"}\n');
		await writeFile(join(contentDir, "theme", "dark.json"), "{}\n");
		const isZip = target.os === "win32";
		const fileName = `step-${VERSION}-${target.id}.${isZip ? "zip" : "tar.gz"}`;
		const archivePath = join(archivesDir, fileName);
		const result = isZip
			? spawnSync("zip", ["-qr", archivePath, "."], { cwd: contentDir })
			: spawnSync("tar", ["-czf", archivePath, "step"], { cwd: join(contentDir, "..") });
		assert.equal(result.status, 0, String(result.stderr));
		packages[target.id] = `https://releases.example.test/stepcode/${VERSION}/${fileName}`;
		checksums[target.id] = createHash("sha256")
			.update(await readFile(archivePath))
			.digest("hex");
	}
	await writeFile(join(archivesDir, "manifest.json"), JSON.stringify({ version: VERSION, packages, checksums }));
	return archivesDir;
}

const canRun = commandAvailable("zip", "-v") && commandAvailable("unzip", "-v") && process.platform !== "win32";

test("main manifest pins every platform package to the release version", () => {
	const manifest = createMainManifest(VERSION);
	assert.equal(manifest.name, NPM_MAIN_PACKAGE);
	assert.deepEqual(manifest.bin, { step: "bin/step.cjs" });
	assert.equal(Object.keys(manifest.optionalDependencies).length, NPM_TARGETS.length);
	for (const target of NPM_TARGETS) {
		assert.equal(manifest.optionalDependencies[platformPackageName(target)], VERSION);
	}
});

test("derives the npmrc auth line from the registry URL", () => {
	assert.equal(
		npmrcAuthLine("https://artifactory.example.test/artifactory/api/npm/npm-public/"),
		"//artifactory.example.test/artifactory/api/npm/npm-public/:_authToken=${NPM_TOKEN}",
	);
	assert.equal(npmrcAuthLine("https://registry.example.test"), "//registry.example.test/:_authToken=${NPM_TOKEN}");
});

test("stages platform packages from release archives and runs through the launcher", { skip: !canRun }, async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-npm-test-"));
	try {
		const archivesDir = await writeFakeRelease(root);
		const outDir = join(root, "out");
		const staged = await stagePackages({ version: VERSION, archivesDir, outDir });
		assert.equal(staged.length, NPM_TARGETS.length + 1);
		assert.equal(staged.at(-1).name, NPM_MAIN_PACKAGE, "launcher package must publish last");

		for (const target of NPM_TARGETS) {
			const dir = staged.find((pkg) => pkg.name === platformPackageName(target)).dir;
			const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			assert.deepEqual(manifest.os, [target.os]);
			assert.deepEqual(manifest.cpu, [target.cpu]);
			// The archive's own package.json is runtime data and must survive under vendor/.
			assert.match(await readFile(join(dir, "vendor", "package.json"), "utf8"), /embedded-runtime-manifest/);
			assert.ok((await stat(join(dir, "vendor", "theme", "dark.json"))).isFile());
			if (target.os !== "win32") assert.ok((await stat(join(dir, "vendor", target.binary))).mode & 0o100);
		}

		// Simulate the global install layout for the current platform.
		const current = NPM_TARGETS.find((target) => target.os === process.platform && target.cpu === process.arch);
		if (!current) return;
		const nodeModules = join(root, "global", "node_modules");
		const mainInstall = join(nodeModules, NPM_MAIN_PACKAGE);
		const platformInstall = join(nodeModules, platformPackageName(current));
		await cp(staged.at(-1).dir, mainInstall, { recursive: true });
		await cp(staged.find((pkg) => pkg.name === platformPackageName(current)).dir, platformInstall, {
			recursive: true,
		});
		const run = spawnSync(process.execPath, [join(mainInstall, "bin", "step.cjs"), "7", "--flag"], {
			encoding: "utf8",
		});
		assert.equal(run.status, 7);
		assert.equal(run.stdout.trim(), "args=7 --flag method=npm");

		await rm(platformInstall, { recursive: true });
		const missing = spawnSync(process.execPath, [join(mainInstall, "bin", "step.cjs")], { encoding: "utf8" });
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /--omit=optional/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects an archive whose checksum does not match the manifest", { skip: !canRun }, async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-npm-test-"));
	try {
		const archivesDir = await writeFakeRelease(root);
		const manifestPath = join(archivesDir, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.checksums[NPM_TARGETS[0].id] = "0".repeat(64);
		await writeFile(manifestPath, JSON.stringify(manifest));
		await assert.rejects(
			stagePackages({ version: VERSION, archivesDir, outDir: join(root, "out") }),
			/Checksum mismatch/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
