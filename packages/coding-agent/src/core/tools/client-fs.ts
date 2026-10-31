import { extname } from "node:path";
import { defaultEditOperations, type EditOperations, type EditToolOptions } from "./edit.ts";
import { defaultReadOperations, type ReadOperations, type ReadToolOptions } from "./read.ts";
import { defaultWriteOperations, type WriteOperations, type WriteToolOptions } from "./write.ts";

/**
 * A protocol client's filesystem, reachable over the client's reverse-RPC
 * channel.
 *
 * ACP defines `fs/read_text_file` and `fs/write_text_file` as client-side
 * methods: the agent asks, the client answers. Both names say "text" on
 * purpose, so the bridge carries text only. Binary payloads (images the read
 * tool attaches) stay on the local filesystem, where the bytes are the bytes.
 */
export interface ClientFileSystemBridge {
	/**
	 * Absent when the client did not advertise `fs.readTextFile`.
	 *
	 * Optional rather than required because ACP gates the two directions
	 * independently: a client may offer writes and not reads, or the reverse.
	 * A missing method means "stay local for this direction", not "fail", so the
	 * wrappers check before they delegate.
	 */
	readTextFile?(absolutePath: string): Promise<string>;
	writeTextFile?(absolutePath: string, content: string): Promise<void>;
}

/**
 * Extensions the read tool attaches as images.
 *
 * The tool decides between its text and image branches by asking
 * `detectImageMimeType`, which stays local because it reads the file header.
 * When that says "image", the following `readFile` must return the real bytes,
 * so a bridged read has to stand down for these paths. Duplicating the
 * extension set here is deliberate: the alternative is a second round-trip to
 * the client to learn something the local header already answered.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * The client filesystem installed by the current protocol host.
 *
 * Process-scoped on purpose, for the same reason the MCP host overlay is: a
 * host that supports exactly one active session at a time (ACP, RPC) installs
 * its bridge before that session starts and clears it when the session ends, so
 * at most one bridge is ever live. Tools read it at call time rather than
 * capturing it at construction time, which is what lets the profile be built
 * once per process while the bridge comes and goes with the client's
 * capabilities.
 */
let clientFileSystemBridge: ClientFileSystemBridge | undefined;

export function setClientFileSystemBridge(bridge: ClientFileSystemBridge | undefined): void {
	clientFileSystemBridge = bridge;
}

export function getClientFileSystemBridge(): ClientFileSystemBridge | undefined {
	return clientFileSystemBridge;
}

function isImagePath(absolutePath: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase());
}

/**
 * Route text reads through the client when one is installed.
 *
 * The local operations stay as the fallback for paths the bridge does not
 * cover: image paths and the no-bridge case. The protocol host may also install
 * a narrow `methodNotFound` fallback; other client failures propagate so the
 * caller never receives a stale local copy in place of the editor's buffer.
 */
export function withClientFileSystemRead<T extends ReadOperations>(operations: T): T {
	return {
		...operations,
		readFile: async (absolutePath: string) => {
			const bridge = clientFileSystemBridge;
			if (bridge?.readTextFile === undefined || isImagePath(absolutePath)) {
				return operations.readFile(absolutePath);
			}
			return Buffer.from(await bridge.readTextFile(absolutePath), "utf-8");
		},
	};
}

/** Route writes through the client when one is installed. */
export function withClientFileSystemWrite<T extends WriteOperations>(operations: T): T {
	return {
		...operations,
		writeFile: async (absolutePath: string, content: string) => {
			const bridge = clientFileSystemBridge;
			if (bridge?.writeTextFile === undefined) return operations.writeFile(absolutePath, content);
			await bridge.writeTextFile(absolutePath, content);
		},
		readFile: operations.readFile
			? async (absolutePath: string) => {
					const bridge = clientFileSystemBridge;
					if (bridge?.readTextFile === undefined) return operations.readFile?.(absolutePath);
					return bridge.readTextFile(absolutePath);
				}
			: operations.readFile,
	};
}

/**
 * Route edits through the client when one is installed.
 *
 * The edit tool reads a file, applies a replacement, and writes it back, so both
 * halves have to travel the same road. Sending the read through the client and
 * the write locally would edit a file the client never saw change, which is the
 * exact drift the capability exists to prevent.
 */
export function withClientFileSystemEdit<T extends EditOperations>(operations: T): T {
	return {
		...operations,
		readFile: async (absolutePath: string) => {
			const bridge = clientFileSystemBridge;
			if (bridge?.readTextFile === undefined || isImagePath(absolutePath)) {
				return operations.readFile(absolutePath);
			}
			return Buffer.from(await bridge.readTextFile(absolutePath), "utf-8");
		},
		writeFile: async (absolutePath: string, content: string) => {
			const bridge = clientFileSystemBridge;
			if (bridge?.writeTextFile === undefined) return operations.writeFile(absolutePath, content);
			await bridge.writeTextFile(absolutePath, content);
		},
	};
}

/**
 * Option-level wrappers, so a caller that passes no operations still gets the
 * bridge. Wrapping only a caller-supplied operations object would leave the
 * default path, which is the common one, permanently local.
 */
export function withClientFileSystemReadOptions(options: ReadToolOptions | undefined): ReadToolOptions {
	return { ...options, operations: withClientFileSystemRead(options?.operations ?? defaultReadOperations) };
}

export function withClientFileSystemWriteOptions(options: WriteToolOptions | undefined): WriteToolOptions {
	return { ...options, operations: withClientFileSystemWrite(options?.operations ?? defaultWriteOperations) };
}

export function withClientFileSystemEditOptions(options: EditToolOptions | undefined): EditToolOptions {
	return { ...options, operations: withClientFileSystemEdit(options?.operations ?? defaultEditOperations) };
}
