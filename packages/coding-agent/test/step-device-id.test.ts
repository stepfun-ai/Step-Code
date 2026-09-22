import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	readOrCreateStepDeviceId,
	readStepDeviceId,
	resolveStepDeviceIdPath,
	resolveStepStorageRoot,
} from "../src/step/device-id.ts";

describe("Step device id", () => {
	it("creates a stable private identifier and reads it back", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-device-id-"));
		try {
			const first = await readOrCreateStepDeviceId(root);
			const second = await readOrCreateStepDeviceId(root);

			expect(first.created).toBe(true);
			expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
			expect(second).toEqual({ deviceId: first.deviceId, created: false });
			expect(await readStepDeviceId(root)).toBe(first.deviceId);
			expect((await stat(resolveStepDeviceIdPath(root))).mode & 0o777).toBe(0o600);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not overwrite an identifier won by another process", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-device-id-"));
		try {
			const results = await Promise.all(Array.from({ length: 8 }, () => readOrCreateStepDeviceId(root)));
			const ids = new Set(results.map((result) => result.deviceId).filter((id): id is string => Boolean(id)));
			expect(ids.size).toBe(1);
			expect(results.filter((result) => result.created)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns no id for a missing file when only reading", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-device-id-"));
		try {
			expect(await readStepDeviceId(root)).toBeUndefined();
			await expect(access(resolveStepDeviceIdPath(root))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("derives the identity root from the same Step config directory as the agent", () => {
		expect(
			resolveStepStorageRoot({
				HOME: "/tmp/step-home",
				STEPCODE_CONFIG_DIR: ".step-custom",
			}),
		).toBe("/tmp/step-home/.step-custom");
	});
});
