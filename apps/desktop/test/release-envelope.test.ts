import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveWebServerEntry } from "../src/server-host.ts";
import {
	parseReleaseEnvelope,
	readReleaseEnvelope,
	RELEASE_ENVELOPE_FILE,
	withReleaseIdentity,
} from "../src/release-envelope.ts";

const envelope = {
	version: "0.2.0",
	channel: "release",
	commit: "81e79bc4",
	buildTime: "2026-10-23T08:00:00.000Z",
	installSource: "dmg",
	feedbackEndpoint: "https://feedback.example.test/v1/reports",
	feedbackBundleEndpoint: "https://feedback.example.test/v1/bundles",
};

async function fixture(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "stepcode-desktop-release-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("a valid envelope maps to the server's identity environment", () => {
	const parsed = parseReleaseEnvelope(envelope);
	assert.ok(parsed);
	const environment = withReleaseIdentity({ PATH: "/usr/bin" }, parsed);
	assert.deepEqual(environment, {
		PATH: "/usr/bin",
		STEPCODE_BUILD_VERSION: "0.2.0",
		STEPCODE_BUILD_CHANNEL: "release",
		STEPCODE_BUILD_COMMIT: "81e79bc4",
		STEPCODE_BUILD_TIME: "2026-10-23T08:00:00.000Z",
		STEPCODE_INSTALL_SOURCE: "dmg",
		STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.example.test/v1/reports",
		STEPCODE_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.example.test/v1/bundles",
	});
});

test("an envelope on disk is read beside the server entry", async (t) => {
	const directory = await fixture(t);
	await writeFile(join(directory, RELEASE_ENVELOPE_FILE), `${JSON.stringify(envelope, null, "\t")}\n`);
	const parsed = readReleaseEnvelope(directory);
	assert.equal(parsed?.version, "0.2.0");
	assert.equal(parsed?.installSource, "dmg");
});

test("a missing envelope leaves the inherited dev identity untouched", async (t) => {
	const directory = await fixture(t);
	const warnings: string[] = [];
	assert.equal(
		readReleaseEnvelope(directory, (warning) => warnings.push(warning)),
		undefined,
	);
	assert.deepEqual(warnings, []);

	const base = { PATH: "/bin", STEPCODE_BUILD_CHANNEL: "dev" };
	assert.deepEqual(withReleaseIdentity(base, undefined), base);
	assert.equal(withReleaseIdentity(base, undefined).STEPCODE_BUILD_VERSION, undefined);
});

test("a malformed envelope is ignored and produces no identity environment", async (t) => {
	const directory = await fixture(t);
	const warnings: string[] = [];
	await writeFile(join(directory, RELEASE_ENVELOPE_FILE), "{ not json");
	assert.equal(
		readReleaseEnvelope(directory, (warning) => warnings.push(warning)),
		undefined,
	);
	assert.equal(warnings.length, 1);

	assert.equal(parseReleaseEnvelope({ channel: "release" }), undefined);
	assert.equal(parseReleaseEnvelope({ ...envelope, channel: "dev" }), undefined);
	assert.equal(parseReleaseEnvelope({ ...envelope, version: "0.2.0\nx" }), undefined);
	assert.equal(parseReleaseEnvelope([]), undefined);

	const base = { PATH: "/bin" };
	assert.deepEqual(withReleaseIdentity(base, readReleaseEnvelope(directory)), base);
});

test("feedback endpoints must be http(s) without credentials", () => {
	const parsed = parseReleaseEnvelope({
		...envelope,
		feedbackEndpoint: "ftp://feedback.example.test/v1/reports",
		feedbackBundleEndpoint: "https://user:secret@feedback.example.test/v1/bundles",
	});
	assert.ok(parsed);
	assert.equal(parsed.feedbackEndpoint, undefined);
	assert.equal(parsed.feedbackBundleEndpoint, undefined);
	assert.equal(parsed.version, "0.2.0");

	const environment = withReleaseIdentity({}, parsed);
	assert.equal("STEPCODE_FEEDBACK_ENDPOINT" in environment, false);
	assert.equal("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT" in environment, false);
});

test("oversized, control-bearing and malformed values are dropped", () => {
	const parsed = parseReleaseEnvelope({
		...envelope,
		commit: "a".repeat(41),
		buildTime: "not a timestamp",
		installSource: "dm\ng",
		feedbackEndpoint: `https://feedback.example.test/${"a".repeat(2048)}`,
	});
	assert.ok(parsed);
	assert.equal(parsed.commit, undefined);
	assert.equal(parsed.buildTime, undefined);
	assert.equal(parsed.installSource, undefined);
	assert.equal(parsed.feedbackEndpoint, undefined);
	// A dropped optional field must not discard the release identity itself.
	assert.equal(parsed.channel, "release");
	assert.equal(parsed.version, "0.2.0");

	const environment = withReleaseIdentity({}, parsed);
	assert.deepEqual(environment, {
		STEPCODE_BUILD_VERSION: "0.2.0",
		STEPCODE_BUILD_CHANNEL: "release",
		STEPCODE_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.example.test/v1/bundles",
	});
});

test("a packaged envelope overrides inherited release claims", () => {
	const inherited = {
		PATH: "/usr/bin",
		STEPCODE_BUILD_VERSION: "9.9.9",
		STEPCODE_VERSION_OVERRIDE: "9.9.9-local",
		STEPCODE_BUILD_CHANNEL: "release",
		STEPCODE_BUILD_COMMIT: "deadbeef",
		STEP_HARNESS_BUILD_COMMIT: "deadbeef",
		STEP_HARNESS_BUILD_TIME: "2000-01-01T00:00:00.000Z",
		STEPCODE_INSTALL_SOURCE: "npm",
		STEPCODE_DISTRIBUTION: "zip",
		STEPCODE_FEEDBACK_ENDPOINT: "https://user-exported.example.test/report",
		STEP_HARNESS_FEEDBACK_ENDPOINT: "https://user-exported.example.test/report",
		STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT: "https://user-exported.example.test/bundle",
	};
	const parsed = parseReleaseEnvelope({
		version: "0.2.0",
		channel: "release",
		installSource: "dmg",
	});
	assert.ok(parsed);
	const environment = withReleaseIdentity(inherited, parsed);
	assert.deepEqual(environment, {
		PATH: "/usr/bin",
		STEPCODE_BUILD_VERSION: "0.2.0",
		STEPCODE_BUILD_CHANNEL: "release",
		STEPCODE_INSTALL_SOURCE: "dmg",
	});
	// The caller's environment is not mutated.
	assert.equal(inherited.STEPCODE_BUILD_VERSION, "9.9.9");
});

test("a JSON string and a release tag are normalized like the kernel", () => {
	const parsed = parseReleaseEnvelope(JSON.stringify(envelope).replace('"0.2.0"', '"v0.2.0"'));
	assert.equal(parsed?.version, "0.2.0");
	assert.equal(parseReleaseEnvelope("[]"), undefined);
});

/**
 * The envelope's location is a contract between two files that never import
 * each other: `scripts/package.mjs` writes it, the shell reads
 * `dirname(resolveWebServerEntry(...))`. When they disagreed, a packaged app
 * silently reported fallback identity and refused feedback — the exact symptom
 * the envelope exists to remove — so the layout is pinned here.
 */
test("the packaged server entry resolves beside the envelope", async (t) => {
	const serverRoot = await fixture(t);
	const serverDist = join(serverRoot, "node_modules", "@step-harness", "web", "dist");
	await mkdir(serverDist, { recursive: true });
	await writeFile(join(serverRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
	await writeFile(
		join(serverRoot, "node_modules", "@step-harness", "web", "package.json"),
		JSON.stringify({ name: "@step-harness/web", version: "0.0.0", type: "module", exports: { "./server": "./dist/server.js" } }),
	);
	await writeFile(join(serverDist, "server.js"), "export {};\n");
	// Written the way `writeReleaseEnvelope` does: beside the resolved entry.
	const require = createRequire(join(serverRoot, "package.json"));
	const entry = require.resolve("@step-harness/web/server");
	await writeFile(join(dirname(entry), RELEASE_ENVELOPE_FILE), JSON.stringify(envelope));

	const resolved = resolveWebServerEntry({}, serverRoot);
	assert.equal(resolved, entry, "the shell and the test disagree about the server entry");
	const read = readReleaseEnvelope(dirname(resolved));
	assert.ok(read, "the shell cannot find the envelope beside the server entry it resolved");
	const environment = withReleaseIdentity({}, read);
	assert.equal(environment.STEPCODE_BUILD_VERSION, "0.2.0");
	assert.equal(environment.STEPCODE_INSTALL_SOURCE, "dmg");
});
