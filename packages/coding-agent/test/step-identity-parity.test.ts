import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFeedbackContext } from "../src/step/feedback/context.ts";
import { createStepTelemetryRuntime } from "../src/step/telemetry-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("feedback and telemetry identity parity", () => {
	it("uses the same build aliases and wire boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-identity-parity-"));
		roots.push(root);
		const telemetryDirectory = join(root, "telemetry");
		const deviceId = "device-identity-42";
		await writeFile(join(root, "device-id"), `${deviceId}\n`);
		const env: NodeJS.ProcessEnv = {
			STEP_HARNESS_BUILD_CHANNEL: " ",
			STEP_CLI_BUILD_CHANNEL: "release",
			STEP_HARNESS_BUILD_COMMIT: " ",
			STEP_CLI_BUILD_COMMIT: "legacy123",
			STEP_HARNESS_VERSION_OVERRIDE: "v9.9.9",
			STEP_HARNESS_UID: "u".repeat(65),
			STEP_HARNESS_USER: " analyst@example.test ",
		};
		const sessionId = "team/agent one";
		const feedbackContext = await resolveFeedbackContext({
			storageRootDir: root,
			env,
			sessionId,
			uid: env.STEP_HARNESS_UID,
		});

		const runtime = createStepTelemetryRuntime({
			enabled: true,
			env,
			context: { sessionId, deviceId },
			spoolDirectory: telemetryDirectory,
			flushThreshold: 10,
			flushIntervalMs: 0,
		});
		runtime.track("first_launch", { channel: "release" });
		await runtime.shutdown();

		const files = await readdir(telemetryDirectory);
		const eventsFile = files.find((file) => file.startsWith("events-"));
		expect(eventsFile).toBeDefined();
		const records = (await readFile(join(telemetryDirectory, eventsFile!), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { context: Record<string, unknown> });
		expect(records).toHaveLength(1);
		expect(records[0]?.context).toEqual(feedbackContext);
	});
});
