import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@step-harness/pi-tui";
import type { ImageContent, TextContent } from "@step-harness/providers";
import type { Theme } from "../../theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Collapses carriage-return refresh sequences (progress bars, spinners from
 * npm/docker/curl) to their final frame instead of stacking every frame on
 * its own line.
 */
export function collapseCarriageReturns(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const frames = line.split("\r");
			// Take the last non-empty frame: a line ending in a bare \r
			// (e.g. "[####] 100%\r") splits into a trailing "" that would
			// otherwise blank out the whole line.
			let i = frames.length - 1;
			while (i > 0 && frames[i] === "") i--;
			return frames[i] ?? "";
		})
		.join("\n");
}

export function normalizeDisplayText(text: string): string {
	return collapseCarriageReturns(text);
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks
		.map((c) => collapseCarriageReturns(sanitizeBinaryOutput(stripAnsi(c.text || ""))))
		.join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	// 路径跟随工具名（toolTitle）而非 accent——accent 是交互色，品牌紫锚点
	// 只保留在工具行（名字+路径）上，spinner/选中态不再共用它。
	return linkPath(theme.fg("toolTitle", shortenPath(value)), value, cwd);
}
