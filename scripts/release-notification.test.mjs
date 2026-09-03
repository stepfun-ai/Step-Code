import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciConfig = parse(readFileSync(path.join(repoRoot, ".gitlab-ci.yml"), "utf8"));

test("notify_release runs automatically only after the Step CLI release", () => {
	const job = ciConfig.notify_release;
	assert.ok(job, "expected notify_release to exist");
	assert.equal(job.stage, "notify");
	assert.ok(ciConfig.stages.indexOf("notify") > ciConfig.stages.indexOf("publish"));
	assert.deepEqual(job.needs, [{ job: "publish_release", artifacts: false }]);
	assert.deepEqual(job.rules, [
		{ if: "$CI_COMMIT_TAG", when: "on_success" },
		{ when: "never" },
	]);
	assert.notEqual(job.when, "manual");
	assert.equal(
		ciConfig.variables.STEP_RELEASE_BOT_WEBHOOK_URL,
		"https://test-openapi-stepcli-bot.c.stepfun-inc.net/webhooks/step-harness/release",
	);
	assert.ok(ciConfig.variables.STEP_RELEASE_BOT_WEBHOOK_TOKEN.length >= 32);

	const script = job.script.join("\n");
	for (const field of ["version", "commit_sha", "pipeline_url", "release_url", "project_path"]) {
		assert.match(script, new RegExp(`\\b${field}\\b`));
	}
	assert.match(script, /JSON\.stringify\(payload\)/);
	assert.match(script, /Authorization: `Bearer \$\{process\.env\.STEP_RELEASE_BOT_WEBHOOK_TOKEN\}`/);
	for (const line of script.split("\n")) {
		if (/\b(?:echo|console\.log)\b/.test(line)) {
			assert.doesNotMatch(line, /STEP_RELEASE_BOT_WEBHOOK_TOKEN/);
		}
	}
});

test("notify_release fails closed when webhook configuration is missing", () => {
	const shellScript = ciConfig.notify_release.script.find((entry) =>
		entry.includes("STEP_RELEASE_BOT_WEBHOOK_URL"),
	);
	const match = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/.exec(shellScript);
	assert.ok(match, "expected an executable Node heredoc in notify_release");
	const javascript = match[1];
	const baseEnv = {
		CI_COMMIT_TAG: "v0.3.1",
		CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
		CI_PIPELINE_URL: "https://gitlab.basemind.com/aiagent/step-harness/-/pipelines/123",
		CI_PROJECT_URL: "https://gitlab.basemind.com/aiagent/step-harness",
		CI_PROJECT_PATH: "aiagent/step-harness",
		STEP_RELEASE_BOT_WEBHOOK_URL: "https://bot.example.com/webhooks/step-harness/release",
		STEP_RELEASE_BOT_WEBHOOK_TOKEN: "masked-token-for-test-0123456789",
	};

	for (const missingName of ["STEP_RELEASE_BOT_WEBHOOK_URL", "STEP_RELEASE_BOT_WEBHOOK_TOKEN"]) {
		const env = { ...baseEnv };
		delete env[missingName];
		const result = spawnSync(process.execPath, ["--input-type=module"], {
			input: javascript,
			env,
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0, `${missingName} should be required`);
		assert.match(result.stderr, new RegExp(missingName));
		assert.doesNotMatch(result.stdout + result.stderr, /masked-token-for-test-0123456789/);
	}
});
