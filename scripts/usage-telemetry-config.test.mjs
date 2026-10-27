import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_CONFIG_BYTES, normalizeConfig, readUsageTelemetryConfig } from "./load-usage-telemetry-config.mjs";

const script = fileURLToPath(new URL("./load-usage-telemetry-config.mjs", import.meta.url));

function fileWith(text, name = "usage-telemetry.yaml") {
	const directory = mkdtempSync(join(tmpdir(), "usage-telemetry-config-"));
	const path = join(directory, name);
	writeFileSync(path, text);
	return path;
}

test("a config carries the collector, the internal hosts, and future keys", () => {
	const path = fileWith(`enabled: true
endpoint: https://collector.example.test/api/v1/events
internalProviderHosts:
  - Gateway.Example.test
  - gateway.example.test
  - other.example.test
sampleRate: 0.5
`);
	assert.deepEqual(readUsageTelemetryConfig({ file: path }), {
		enabled: true,
		endpoint: "https://collector.example.test/api/v1/events",
		internalProviderHosts: ["gateway.example.test", "other.example.test"],
		sampleRate: 0.5,
	});
});

test("a file with no values means no reporting, which is how the public tree ships", () => {
	assert.deepEqual(readUsageTelemetryConfig({ file: fileWith("# only comments\n") }), {});
	assert.deepEqual(normalizeConfig({ endpoint: "  ", internalProviderHosts: [] }), {});
});

test("hosts may be a comma-separated string", () => {
	assert.deepEqual(normalizeConfig({ internalProviderHosts: " a.test , B.test " }).internalProviderHosts, [
		"a.test",
		"b.test",
	]);
});

test("no file means no reporting rather than a failed build", () => {
	assert.deepEqual(readUsageTelemetryConfig({ file: join(tmpdir(), "does-not-exist.yaml") }), {});
	assert.throws(() => readUsageTelemetryConfig({ file: join(tmpdir(), "does-not-exist.yaml"), require: true }), /not found/u);
});

test("a malformed known field fails instead of silently disabling reporting", () => {
	const cases = [
		["- a list", /mapping/u],
		["enabled: yes", /enabled/u],
		["endpoint: ftp://x.test", /http/u],
		["endpoint: https://user:pass@x.test", /credentials/u],
		["endpoint: not a url", /URL/u],
		["internalProviderHosts: [1]", /strings/u],
		["internalProviderHosts: ['a b']", /invalid internal provider host/u],
		[`unknown: ${"x".repeat(MAX_CONFIG_BYTES)}`, /bytes/u],
	];
	for (const [text, pattern] of cases) {
		assert.throws(() => readUsageTelemetryConfig({ file: fileWith(text) }), pattern, text);
	}
});

test("the CLI prints compact JSON and fails on an unreadable file", () => {
	const path = fileWith("endpoint: https://collector.example.test/ingest\n");
	assert.equal(execFileSync(process.execPath, [script, "--file", path], { encoding: "utf8" }), '{"endpoint":"https://collector.example.test/ingest"}');
	assert.throws(() => execFileSync(process.execPath, [script, "--file", join(tmpdir(), "missing.yaml"), "--require"], { stdio: "pipe" }), /Command failed/u);
});
