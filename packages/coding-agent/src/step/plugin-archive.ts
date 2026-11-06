import { crc32, inflateRawSync } from "node:zlib";

export const MAX_PLUGIN_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 6000;
export interface PluginFile {
	readonly path: string;
	readonly data: Buffer;
	readonly executable?: boolean;
}
export class PluginInstallError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}
export function safePluginPath(value: string): boolean {
	return (
		value.length > 0 &&
		value.length < 1024 &&
		!/[\\\x00-\x1f:<>"|?*]/u.test(value) &&
		value
			.split("/")
			.every(
				(part) =>
					Boolean(part) &&
					part !== "." &&
					part !== ".." &&
					!/[. ]$/u.test(part) &&
					!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
			)
	);
}

/** No subprocesses or extraction tools: validate central and local records before writing anything. */
export function readPluginZip(
	data: Buffer,
	limits: { readonly files: number; readonly bytes: number } = {
		files: MAX_PLUGIN_FILES,
		bytes: MAX_PLUGIN_EXPANDED_BYTES,
	},
): PluginFile[] {
	const fail = (): never => {
		throw new PluginInstallError("Invalid or unsupported plugin ZIP archive");
	};
	if (data.length < 22 || data.length > MAX_PLUGIN_ARCHIVE_BYTES) fail();
	let end = data.length - 22;
	while (end >= Math.max(0, data.length - 65557)) {
		if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break;
		end--;
	}
	if (end < Math.max(0, data.length - 65557)) fail();
	const count = data.readUInt16LE(end + 10);
	const central = data.readUInt32LE(end + 16);
	if (
		!count ||
		count > limits.files ||
		data.readUInt16LE(end + 4) ||
		data.readUInt16LE(end + 6) ||
		data.readUInt16LE(end + 8) !== count ||
		central + data.readUInt32LE(end + 12) !== end
	)
		fail();
	const files: PluginFile[] = [];
	const seen = new Set<string>();
	const ranges: Array<{ start: number; end: number }> = [];
	let offset = central;
	let expanded = 0;
	for (let i = 0; i < count; i++) {
		if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) fail();
		const flags = data.readUInt16LE(offset + 8);
		const method = data.readUInt16LE(offset + 10);
		const crc = data.readUInt32LE(offset + 16);
		const compressed = data.readUInt32LE(offset + 20);
		const size = data.readUInt32LE(offset + 24);
		const nameLength = data.readUInt16LE(offset + 28);
		const local = data.readUInt32LE(offset + 42);
		const next = offset + 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
		if (
			next > end ||
			flags & ~0x080e ||
			flags & 1 ||
			![0, 8].includes(method) ||
			data.readUInt16LE(offset + 34) ||
			compressed === 0xffffffff ||
			size === 0xffffffff
		)
			fail();
		const unixType = (data.readUInt32LE(offset + 38) >>> 16) & 0xf000;
		if (unixType && unixType !== 0x8000 && unixType !== 0x4000) fail();
		const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
		let name: string;
		try {
			name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
		} catch {
			return fail();
		}
		const directory = name.endsWith("/");
		const path = directory ? name.slice(0, -1) : name;
		const key = path.normalize("NFC").toLowerCase();
		if (!safePluginPath(path) || seen.has(key)) fail();
		seen.add(key);
		if (
			local + 30 > central ||
			data.readUInt32LE(local) !== 0x04034b50 ||
			data.readUInt16LE(local + 6) !== flags ||
			data.readUInt16LE(local + 8) !== method ||
			data.readUInt16LE(local + 26) !== nameLength
		)
			fail();
		const start = local + 30 + nameLength + data.readUInt16LE(local + 28);
		if (start + compressed > central || !data.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) fail();
		ranges.push({ start: local, end: start + compressed });
		expanded += size;
		if (expanded > limits.bytes || (directory && size !== 0)) fail();
		let content: Buffer;
		try {
			content =
				method === 0
					? data.subarray(start, start + compressed)
					: inflateRawSync(data.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) });
		} catch {
			return fail();
		}
		if (content.length !== size || crc32(content) !== crc) fail();
		if (!directory && !path.startsWith("__MACOSX/") && !path.endsWith(".DS_Store"))
			files.push({ path, data: content, executable: Boolean((data.readUInt32LE(offset + 38) >>> 16) & 0o111) });
		offset = next;
	}
	if (offset !== end) fail();
	ranges.sort((a, b) => a.start - b.start);
	if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) fail();
	return files;
}
