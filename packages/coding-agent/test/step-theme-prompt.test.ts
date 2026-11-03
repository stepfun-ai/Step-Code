import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepLoginHost } from "../src/step/login-flow.ts";
import { buildStepThemeOptions, type RunStepThemePromptOptions, runStepThemePrompt } from "../src/step/theme-prompt.ts";
import { StepThemePromptView } from "../src/step/theme-prompt-view.ts";
import { getCurrentThemeName, initTheme, setRegisteredThemes } from "../src/theme/theme.ts";

function createHost(): StepLoginHost & { mounted: StepThemePromptView | undefined; stopped: boolean } {
	const host = {
		mounted: undefined as StepThemePromptView | undefined,
		stopped: false,
		addChild(child: unknown) {
			host.mounted = child as StepThemePromptView;
		},
		setFocus() {},
		requestRender() {},
		start() {},
		stop() {
			host.stopped = true;
		},
	};
	return host;
}

describe("buildStepThemeOptions", () => {
	it("leads with the auto pair and its two halves", () => {
		const options = buildStepThemeOptions(
			["dark", "light", "sage", "step-violet", "step-violet-light"],
			"step-violet-light/step-violet",
		);

		expect(options.slice(0, 3)).toEqual([
			{
				setting: "step-violet-light/step-violet",
				label: "Auto (match terminal)",
				description: "step-violet / step-violet-light",
			},
			{ setting: "step-violet", label: "Dark mode", description: "step-violet" },
			{ setting: "step-violet-light", label: "Light mode", description: "step-violet-light" },
		]);
		expect(options.slice(3).map((option) => option.setting)).toEqual(["dark", "light", "sage"]);
	});

	it("lists plain themes when the default pair is not installed", () => {
		const options = buildStepThemeOptions(["dark", "light"], "step-violet-light/step-violet");

		expect(options).toEqual([
			{ setting: "dark", label: "dark" },
			{ setting: "light", label: "light" },
		]);
	});

	it("keeps a non-auto default from being listed twice", () => {
		const options = buildStepThemeOptions(["dark", "light"], "dark");

		expect(options.map((option) => option.setting)).toEqual(["dark", "light"]);
	});

	it("promotes and labels the single blue default without adding variants", () => {
		const options = buildStepThemeOptions(
			["dark", "light", "sage", "step-blue", "step-violet", "step-violet-light", "step-blue"],
			"step-blue",
		);
		expect(options[0]).toEqual({ setting: "step-blue", label: "step-blue (default)" });
		expect(options.map((option) => option.setting)).toEqual([
			"step-blue",
			"dark",
			"light",
			"sage",
			"step-violet",
			"step-violet-light",
		]);
	});

	// An empty catalog is a broken install; the caller puts no question rather
	// than opening a screen with nothing on it.
	it("offers nothing when no theme is installed", () => {
		expect(buildStepThemeOptions([], "step-blue")).toEqual([]);
	});
});

describe("runStepThemePrompt", () => {
	let configRoot: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		configRoot = mkdtempSync(join(tmpdir(), "step-theme-prompt-"));
		env = { STEP_CODING_AGENT_DIR: join(configRoot, "agent"), COLORFGBG: "15;0" };
		initTheme("dark", false);
	});

	afterEach(() => {
		rmSync(configRoot, { recursive: true, force: true });
	});

	function promptOptions(host: StepLoginHost, overrides: Partial<RunStepThemePromptOptions> = {}) {
		return { env, createHost: () => host, themeName: "step-blue", ...overrides };
	}

	it("previews each move and resolves the confirmed setting", async () => {
		const host = createHost();
		const answered = runStepThemePrompt(promptOptions(host));

		await Promise.resolve();
		expect(host.mounted?.render(80).join("\n")).toContain("1. step-blue (default)");
		expect(getCurrentThemeName()).toBe("step-blue");
		host.mounted?.handleInput("\x1b[B");
		expect(getCurrentThemeName()).toBe("dark");
		host.mounted?.handleInput("\r");

		expect(await answered).toBe("dark");
		expect(host.stopped).toBe(true);
	});

	it("answers with the default when the screen is dismissed", async () => {
		const host = createHost();
		const answered = runStepThemePrompt(promptOptions(host));

		await Promise.resolve();
		host.mounted?.handleInput("\x1b[B");
		host.mounted?.handleInput("\x1b[B");
		host.mounted?.handleInput("\x1b");

		// Taking the default is an answer, so the caller has something to persist
		// and the screen needs no separate record of having been shown.
		expect(await answered).toBe("step-blue");
		expect(getCurrentThemeName()).toBe("step-blue");
	});

	it.each(["15;0", "0;15"])("uses blue when no default is supplied with COLORFGBG=%s", async (colorfgbg) => {
		const host = createHost();
		const answered = runStepThemePrompt(
			promptOptions(host, {
				themeName: undefined,
				env: { ...env, COLORFGBG: colorfgbg },
			}),
		);
		await Promise.resolve();
		expect(host.mounted?.render(80).join("\n")).toContain("1. step-blue (default)");
		host.mounted?.handleInput("\r");
		expect(await answered).toBe("step-blue");
		expect(getCurrentThemeName()).toBe("step-blue");
	});

	it("writes nothing of its own", async () => {
		const host = createHost();
		const answered = runStepThemePrompt(promptOptions(host));
		await Promise.resolve();
		host.mounted?.handleInput("\r");
		await answered;

		expect(existsSync(join(configRoot, "config.toml"))).toBe(false);
	});
});

describe("StepThemePromptView", () => {
	it("renders the option list and a preview of the active theme", () => {
		setRegisteredThemes([]);
		initTheme("dark", false);
		const view = new StepThemePromptView(
			[
				{ setting: "step-blue", label: "step-blue (default)" },
				{ setting: "step-violet", label: "step-violet" },
			],
			{
				initialSetting: "step-violet",
				onPreview: () => {},
				onConfirm: () => {},
				onCancel: () => {},
				requestRender: () => {},
			},
		);

		const rendered = view.render(80).join("\n");

		expect(rendered).toContain("Choose the text style that looks best with your terminal");
		expect(rendered).toContain("To change this later, run /theme");
		expect(rendered).toContain("1. step-blue (default)");
		expect(rendered).toContain("2. step-violet");
		expect(rendered).toContain('console.log("Hello, World!");');
		expect(rendered).toContain('console.log("Hello, Step!");');
	});

	it("confirms the option a number key selects", () => {
		initTheme("dark", false);
		const onConfirm = vi.fn();
		const view = new StepThemePromptView(
			[
				{ setting: "step-blue", label: "step-blue (default)" },
				{ setting: "step-violet", label: "step-violet" },
			],
			{ onPreview: () => {}, onConfirm, onCancel: () => {}, requestRender: () => {} },
		);

		view.handleInput("2");

		expect(onConfirm).toHaveBeenCalledWith("step-violet");
	});
});
