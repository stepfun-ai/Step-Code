import { afterEach, describe, expect, test, vi } from "vitest";

// Regression: `step config --help` printed only the resource-config TUI usage and omitted
// the path/show/init inspection subcommands, which are the only in-CLI way to discover them.
// The subcommand section is APP_NAME-gated, so load the modules as the Step product first
// (mirrors step-config-isolation.test.ts).
describe("config --help subcommands", () => {
	const originalArgv1 = process.argv[1];
	const originalAppName = process.env.STEP_CLI_APP_NAME;

	afterEach(() => {
		if (originalArgv1 === undefined) delete process.argv[1];
		else process.argv[1] = originalArgv1;
		if (originalAppName === undefined) delete process.env.STEP_CLI_APP_NAME;
		else process.env.STEP_CLI_APP_NAME = originalAppName;
		vi.restoreAllMocks();
		vi.resetModules();
	});

	test("lists every supported step config subcommand", async () => {
		process.argv[1] = "/tmp/step";
		process.env.STEP_CLI_APP_NAME = "step";
		vi.resetModules();

		const { APP_NAME } = await import("../src/config.ts");
		const { STEP_CONFIG_SUBCOMMANDS } = await import("../src/step/command-compat.ts");
		const { handleConfigCommand } = await import("../src/package-manager-cli.ts");
		expect(APP_NAME).toBe("step");

		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((chunk: unknown) => {
			lines.push(String(chunk));
		});

		const handled = await handleConfigCommand(["config", "--help"]);
		expect(handled).toBe(true);

		const output = lines.join("\n");
		expect(STEP_CONFIG_SUBCOMMANDS.map((sub) => sub.name)).toEqual(["path", "show", "init"]);
		for (const { name } of STEP_CONFIG_SUBCOMMANDS) {
			expect(output).toContain(name);
		}
	});
});
