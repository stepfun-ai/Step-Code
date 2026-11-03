import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableThemes, getAvailableThemesWithPaths, setRegisteredThemes } from "../src/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

describe("theme picker", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-picker-"));
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv("STEP_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		setRegisteredThemes([]);
	});

	afterEach(() => {
		setRegisteredThemes([]);
		rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("uses custom theme content names instead of file names", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "bar",
		};

		const themePath = join(process.env.STEP_CODING_AGENT_DIR!, "themes", "foo.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		expect(getAvailableThemes()).toContain("bar");
		expect(getAvailableThemes()).not.toContain("foo");
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "bar", path: themePath });
		expect(getAvailableThemesWithPaths().some((theme) => theme.name === "foo")).toBe(false);
	});

	it("includes the Step palette as a built-in theme", () => {
		expect(getAvailableThemes()).toHaveLength(6);
		expect(getAvailableThemes()).not.toContain("step");
		expect(getAvailableThemes()).not.toContain("step-light");
		for (const name of ["step-blue", "step-violet", "step-violet-light"]) {
			expect(getAvailableThemes()).toContain(name);
			const stepTheme = getAvailableThemesWithPaths().find((theme) => theme.name === name);
			expect(stepTheme?.path?.endsWith(join("theme", `${name}.json`))).toBe(true);
		}
	});
});
