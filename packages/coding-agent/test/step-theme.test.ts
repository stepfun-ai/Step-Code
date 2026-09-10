import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetCapabilitiesCache, setCapabilities } from "@step-harness/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import {
	getAvailableThemes,
	getMarkdownTheme,
	getResolvedThemeColors,
	getThemeExportColors,
	highlightCode,
	initTheme,
	isLightTheme,
	loadThemeFromPath,
	theme,
} from "../src/theme/theme.ts";

const THEME_FILES = {
	sage: new URL("../src/theme/sage.json", import.meta.url),
	step: new URL("../src/theme/step.json", import.meta.url),
	"step-light": new URL("../src/theme/step-light.json", import.meta.url),
} as const;

type StepThemeName = keyof typeof THEME_FILES;

function channelLuminance(byte: number): number {
	const value = byte / 255;
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(first: string, second: string): number {
	const luminance = (hex: string) => {
		const channel = (offset: number) => channelLuminance(Number.parseInt(hex.slice(offset, offset + 2), 16));
		return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	};
	const firstLuminance = luminance(first);
	const secondLuminance = luminance(second);
	return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function ansi256ToHex(index: number): string {
	if (index < 16) {
		throw new Error(`Step theme foreground unexpectedly quantized to terminal-defined ANSI color ${index}`);
	}
	if (index < 232) {
		const cubeIndex = index - 16;
		const level = (value: number) => (value === 0 ? 0 : 55 + value * 40).toString(16).padStart(2, "0");
		return `#${level(Math.floor(cubeIndex / 36))}${level(Math.floor((cubeIndex % 36) / 6))}${level(cubeIndex % 6)}`;
	}
	const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
	return `#${gray}${gray}${gray}`;
}

function getQuantizedForegrounds(name: StepThemeName): Record<string, string> {
	const sourcePath = THEME_FILES[name];
	const source = JSON.parse(readFileSync(sourcePath, "utf8")) as { colors: Record<string, string | number> };
	const loaded = loadThemeFromPath(fileURLToPath(sourcePath), "256color");
	const foregrounds: Record<string, string> = {};
	for (const token of Object.keys(source.colors)) {
		if (token.endsWith("Bg") || token === "selectedBg" || token === "scrollbarThumb" || token === "searchMatchBg") {
			continue;
		}
		const ansi = loaded.getFgAnsi(token as Parameters<typeof loaded.getFgAnsi>[0]);
		const match = /^\x1b\[38;5;(\d+)m$/.exec(ansi);
		expect(match, `${name}.${token} should use an xterm-256 foreground`).not.toBeNull();
		foregrounds[token] = ansi256ToHex(Number(match![1]));
	}
	return foregrounds;
}

afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark");
});

describe("Step themes", () => {
	test("registers the sage palette and branded light/dark palettes", () => {
		expect(getAvailableThemes()).toEqual(expect.arrayContaining(["sage", "step", "step-light"]));
		expect(getResolvedThemeColors("sage")).toMatchObject({
			accent: "#a3ab78",
			border: "#bde038",
			muted: "#818274",
			userMessageBg: "#17343a",
			mdHeading: "#a3ab78",
			mdLink: "#a3ab78",
			mdCode: "#a3ab78",
			mdListBullet: "#a3ab78",
			syntaxKeyword: "#bde038",
			syntaxFunction: "#a3ab78",
		});
		expect(getResolvedThemeColors("step")).toMatchObject({
			accent: "#ab9eff",
			// 2026-09-09 品牌紫收缩：边框走 line，正文标题/列表符去紫，
			// 紫锚点只剩工具行（toolTitle/mdCode=brand）与门面
			border: "#434751",
			muted: "#7e7e86",
			userMessageBg: "#3d3b39",
			userMessageText: "#e8e8ea",
			mdHeading: "#e8e8ea",
			mdLink: "#82aaff",
			mdCode: "#ab9eff",
			mdListBullet: "#7e7e86",
			toolTitle: "#ab9eff",
			syntaxKeyword: "#e08fdf",
			syntaxFunction: "#82aaff",
			syntaxVariable: "#e8e8ea",
			syntaxType: "#e8c076",
		});
		expect(getResolvedThemeColors("step-light")).toMatchObject({
			accent: "#5b21b6",
			border: "#d9d5e4",
			muted: "#5c5c66",
			userMessageBg: "#e4e0dc",
			mdHeading: "#1a1a22",
			mdLink: "#1d5dc2",
			mdCode: "#5b21b6",
			mdListBullet: "#5c5c66",
			toolTitle: "#5b21b6",
			syntaxKeyword: "#a21caf",
			syntaxFunction: "#1d5dc2",
			syntaxVariable: "#1a1a22",
			syntaxType: "#8a5a00",
		});
		expect(getThemeExportColors("step").pageBg).toBe("#0d1017");
		expect(getThemeExportColors("step-light").pageBg).toBe("#fbfaff");
		expect(isLightTheme("step-light")).toBe(true);
	});

	test.each(["sage"] as const)("%s prose uses one brand color and code uses separate slots", (name) => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme(name);
		const markdown = getMarkdownTheme();
		const brandAnsi = theme.getFgAnsi("accent");

		for (const render of [markdown.heading, markdown.link, markdown.code, markdown.listBullet]) {
			expect(render("sample")).toContain(brandAnsi);
		}

		const highlighted = highlightCode("export function greet(name: string) { return name; }", "typescript").join(
			"\n",
		);
		expect(highlighted).toContain(`${theme.getFgAnsi("syntaxKeyword")}function`);
		expect(highlighted).toContain(`${theme.getFgAnsi("syntaxFunction")}greet`);
		expect(highlighted).not.toContain(`${brandAnsi}function`);
	});

	test("step 系正文不再一紫——品牌紫只锚行内代码（2026-09-09 收缩）", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		for (const name of ["step", "step-light"] as const) {
			initTheme(name);
			const markdown = getMarkdownTheme();

			// 行内代码是品牌锚点（用户点名保留：文件名紫）
			expect(markdown.code("sample")).toContain(theme.getFgAnsi("accent"));
			// 标题=前景、列表符=muted、链接=语法蓝，全部让出品牌紫
			expect(markdown.heading("sample")).toContain(theme.getFgAnsi("text"));
			expect(markdown.heading("sample")).not.toContain(theme.getFgAnsi("accent"));
			expect(markdown.listBullet("sample")).toContain(theme.getFgAnsi("muted"));
			expect(markdown.link("sample")).toContain(theme.getFgAnsi("syntaxFunction"));
			expect(markdown.link("sample")).not.toContain(theme.getFgAnsi("accent"));

			const highlighted = highlightCode("export function greet(name: string) { return name; }", "typescript").join(
				"\n",
			);
			expect(highlighted).toContain(`${theme.getFgAnsi("syntaxKeyword")}function`);
			expect(highlighted).toContain(`${theme.getFgAnsi("syntaxFunction")}greet`);
			expect(highlighted).not.toContain(`${theme.getFgAnsi("accent")}function`);
		}
	});

	test("Step text colors clear WCAG AA in truecolor and xterm-256 modes", () => {
		const foregroundTokens = [
			"text",
			"muted",
			"accent",
			// border 已改为装饰线色（line），不承载文字语义，不参与 4.5 文字对比度契约
			"success",
			"error",
			"warning",
			"mdHeading",
			"mdTableHeader",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
		] as const;

		// The Step CLI sage palette is intentionally preserved as a visual
		// palette; its original user-badge background is not an AA contract for
		// every possible syntax foreground. Keep the stricter user-message
		// contract for the branded Step pair below.
		for (const name of ["sage", "step", "step-light"] as const) {
			expect(existsSync(THEME_FILES[name]), `expected built-in ${name} theme file`).toBe(true);
			const truecolor = getResolvedThemeColors(name);
			const quantized = getQuantizedForegrounds(name);
			const pageBg = getThemeExportColors(name).pageBg;
			expect(pageBg).toMatch(/^#[0-9a-f]{6}$/i);
			const backgrounds = name === "step-light" ? [pageBg!, "#ffffff"] : [pageBg!];

			for (const token of foregroundTokens) {
				for (const background of backgrounds) {
					for (const [mode, foreground] of [
						["truecolor", truecolor[token]],
						["xterm-256", quantized[token]],
					] as const) {
						expect(
							contrastRatio(foreground, background),
							`${name}.${token} on ${background} via ${mode}`,
						).toBeGreaterThanOrEqual(4.5);
					}
				}
			}
		}

		for (const name of ["step", "step-light"] as const) {
			const colors = getResolvedThemeColors(name);
			const quantizedColors = getQuantizedForegrounds(name);
			const quantizedTheme = loadThemeFromPath(fileURLToPath(THEME_FILES[name]), "256color");
			const backgroundMatch = /^\x1b\[48;5;(\d+)m$/.exec(quantizedTheme.getBgAnsi("userMessageBg"));
			expect(backgroundMatch, `${name}.userMessageBg should use an xterm-256 background`).not.toBeNull();
			const userMessageBackgrounds = [
				["truecolor", colors.userMessageBg, colors],
				["xterm-256", ansi256ToHex(Number(backgroundMatch![1])), quantizedColors],
			] as const;
			for (const token of [
				"text",
				"accent",
				"syntaxKeyword",
				"syntaxFunction",
				"syntaxString",
				"syntaxNumber",
				"syntaxType",
			] as const) {
				for (const [mode, background, palette] of userMessageBackgrounds) {
					expect(
						contrastRatio(palette[token], background),
						`${name} user message ${token} via ${mode}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});
});
