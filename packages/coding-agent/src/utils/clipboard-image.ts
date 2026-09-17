import { execFile, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { clipboard } from "./clipboard-native.ts";
import { loadPhoton } from "./photon.ts";

const execFileAsync = promisify(execFile);

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: options?.env,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (!winPathResult.ok) {
			return null;
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (!result.ok) {
			return null;
		}

		const output = result.stdout.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	if (!clipboard || !clipboard.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = isWSL(env);
		const wayland = isWaylandSession(env);

		if (wayland || wsl) {
			image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
		}

		if (!image && wsl) {
			image = readClipboardImageViaPowerShell();
		}

		if (!image && !wayland) {
			image = (await readClipboardImageViaNativeClipboard()) ?? readClipboardImageViaXclip();
		}
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., BMP from WSLg) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}

/** File extensions we treat as pasteable image files. */
const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function isImageFilePath(path: string): boolean {
	return IMAGE_FILE_EXTENSION_REGEX.test(path.trim());
}

/**
 * Clean a file path pasted from a terminal: strip surrounding quotes and the
 * shell escaping a terminal adds when you paste/drag a path with spaces or
 * special characters (e.g. `a\ file\ \(1\).png` -> `a file (1).png`). On Windows
 * backslashes are path separators, so they are left intact. A doubled backslash
 * (`\\`) is preserved as one literal backslash.
 *
 * Use this ONLY on text pasted through the terminal — a path READ back from the
 * clipboard is raw and never shell-escaped, so unescaping it there would corrupt
 * a filename that legitimately contains a backslash.
 */
/** Trim and remove one matched pair of surrounding single/double quotes. */
function stripSurroundingQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function cleanPastedPath(text: string, platform: NodeJS.Platform = process.platform): string {
	const cleaned = stripSurroundingQuotes(text);
	if (platform === "win32") {
		return cleaned;
	}
	const sentinel = ` ${randomUUID()} `;
	return cleaned.replace(/\\\\/g, sentinel).replace(/\\(.)/g, "$1").split(sentinel).join("\\");
}

/**
 * Run a clipboard-reading command asynchronously and return its trimmed stdout,
 * or null on any failure. Uses execFile (non-blocking) rather than spawnSync so
 * the terminal UI never freezes while probing the clipboard — this runs on
 * ordinary pastes, not just an explicit keypress.
 */
async function runClipboardCommand(command: string, args: string[], timeoutMs: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			timeout: timeoutMs,
			maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
			encoding: "utf-8",
		});
		const text = (typeof stdout === "string" ? stdout : String(stdout)).trim();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

function readClipboardFilePathViaOsascript(): Promise<string | null> {
	// A file copied in Finder is a file URL («class furl»), not image data, so
	// readClipboardImage() cannot see it. Ask for its POSIX path instead.
	return runClipboardCommand(
		"osascript",
		["-e", "get POSIX path of (the clipboard as «class furl»)"],
		DEFAULT_LIST_TIMEOUT_MS,
	);
}

async function readClipboardTextLineViaXclipOrWlPaste(): Promise<string | null> {
	return (
		(await runClipboardCommand(
			"xclip",
			["-selection", "clipboard", "-t", "text/plain", "-o"],
			DEFAULT_LIST_TIMEOUT_MS,
		)) ?? (await runClipboardCommand("wl-paste", ["--no-newline"], DEFAULT_LIST_TIMEOUT_MS))
	);
}

function readClipboardTextLineViaPowerShell(): Promise<string | null> {
	return runClipboardCommand(
		"powershell.exe",
		["-NoProfile", "-Command", "Get-Clipboard"],
		DEFAULT_POWERSHELL_TIMEOUT_MS,
	);
}

/**
 * Read the absolute path of an image FILE on the clipboard (e.g. copied in
 * Finder/Explorer), or null. Complements readClipboardImage(), which only reads
 * raw image DATA: a copied file is a file reference, so pasting it yields just
 * the file name as text and the model cannot resolve it. This recovers the real
 * absolute path so the pasted reference is usable.
 */
export async function readClipboardImagePath(options?: { platform?: NodeJS.Platform }): Promise<string | null> {
	const platform = options?.platform ?? process.platform;

	let candidate: string | null = null;
	if (platform === "darwin") {
		candidate = await readClipboardFilePathViaOsascript();
	} else if (platform === "linux") {
		candidate = await readClipboardTextLineViaXclipOrWlPaste();
	} else if (platform === "win32") {
		candidate = await readClipboardTextLineViaPowerShell();
	}

	if (!candidate) {
		return null;
	}
	// A clipboard-read path is raw (never terminal shell-escaped): only strip
	// quotes, do NOT unescape backslashes (that would corrupt a literal backslash
	// in a filename).
	const cleaned = stripSurroundingQuotes(candidate);
	return isImageFilePath(cleaned) ? cleaned : null;
}
