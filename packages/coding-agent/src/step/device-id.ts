import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export { resolveStepStorageRoot } from "./storage-root.ts";

const DEVICE_ID_FILENAME = "device-id";
const DEVICE_ID_FILE_MODE = 0o600;
const DEVICE_ID_DIR_MODE = 0o700;

export interface StepDeviceIdResult {
	readonly deviceId?: string;
	/** True only when this invocation created the identifier file. */
	readonly created: boolean;
}

/** Resolve the product-owned anonymous install identifier path. */
export function resolveStepDeviceIdPath(storageRootDir: string): string {
	return resolve(storageRootDir, DEVICE_ID_FILENAME);
}

/** Read an existing identifier without creating one. */
export async function readStepDeviceId(storageRootDir: string): Promise<string | undefined> {
	try {
		const value = (await readFile(resolveStepDeviceIdPath(storageRootDir), "utf8")).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read or create the stable anonymous install identifier.
 *
 * Creation uses an exclusive write so two concurrently started Step processes
 * converge on the same file instead of silently replacing one another's id.
 * A read-only home is allowed; telemetry simply remains anonymous in that case.
 */
export async function readOrCreateStepDeviceId(storageRootDir: string): Promise<StepDeviceIdResult> {
	const target = resolveStepDeviceIdPath(storageRootDir);
	const existing = await readStepDeviceId(storageRootDir);
	if (existing) return { deviceId: existing, created: false };

	const candidate = randomUUID();
	try {
		await mkdir(resolve(storageRootDir), {
			recursive: true,
			mode: DEVICE_ID_DIR_MODE,
		});
		await writeFile(target, `${candidate}\n`, {
			encoding: "utf8",
			mode: DEVICE_ID_FILE_MODE,
			flag: "wx",
		});
		return { deviceId: candidate, created: true };
	} catch {
		// Another process may have won the race, or the storage root may be
		// read-only. Prefer the winner's id when it is now visible.
		const winner = await readStepDeviceId(storageRootDir);
		return winner ? { deviceId: winner, created: false } : { created: false };
	}
}
