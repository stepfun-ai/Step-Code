import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../src/core/extensions/types.ts";
import { StepPermissionController } from "../src/step/permissions.ts";

describe("incomplete command analysis requires an explicit decision", () => {
	it.each(['[ -n "$PATH" ]', 'export PATH="$PATH"', `export FOO="\${BAR:-safe}"`])(
		"keeps ordinary prefixes eligible for unattended execution: %s",
		async (commandPrefix) => {
			for (const initialPreset of ["bypass", "autopilot"] as const) {
				const controller = new StepPermissionController({
					env: {},
					initialPreset,
					shellContext: () => ({ commandPrefix }),
				});
				const input = { command: "printf safe" };
				expect(controller.decide("run_command", input)).toMatchObject({ action: "allow", hazardous: false });
				const event: ToolCallEvent = { type: "tool_call", toolName: "run_command", toolCallId: "prefix", input };
				expect(await controller.handleToolCall(event, { hasUI: false } as ExtensionContext)).toBeUndefined();
			}
		},
	);

	it.each([
		{ toolName: "run_command", input: { command: "" } },
		{ toolName: "run_command", input: { command: " \n\t" } },
		{ toolName: "bash", input: { command: "" } },
		{ toolName: "bash", input: { command: ":", run_in_background: true } },
	])("checks the executed prefix for $toolName input $input", async ({ toolName, input }) => {
		const controller = new StepPermissionController({
			env: {},
			initialPreset: "bypass",
			nonInteractiveApproval: "allow",
			shellContext: () => ({ commandPrefix: "rm -rf ./build" }),
		});
		expect(controller.decide(toolName, input)).toMatchObject({ action: "confirm", hazardous: true });
		const event = { type: "tool_call", toolName, toolCallId: "prefix", input } as ToolCallEvent;
		expect(await controller.handleToolCall(event, { hasUI: false } as ExtensionContext)).toMatchObject({
			block: true,
			terminate: true,
		});
	});

	it("omits the prefix only for the background tool that omits it during execution", () => {
		const controller = new StepPermissionController({
			env: {},
			initialPreset: "bypass",
			shellContext: () => ({ commandPrefix: "rm -rf ./build" }),
		});
		expect(controller.decide("run_command", { command: ":", run_in_background: true })).toMatchObject({
			action: "allow",
			hazardous: false,
		});
	});

	const dialectScript = ["cat <<$'EOF'", "EOF", "printf '%s' '", "$EOF", "rm -rf ./build", "#'"].join("\n");
	it.each([
		...["dash", "sh"].map((shell) => `${shell} -c '${dialectScript.replaceAll("'", "'\\''")}'`),
		"echo 'unfinished",
		"rm -rf ./build; echo 'unfinished",
		'reboot; echo "unfinished',
		'echo "$(printf \'unfinished)"',
		"cat <<EOF\nhello\n",
		'"$COMMAND" -rf ./build',
		'bash -c "$SCRIPT"',
		'env -S "$COMMAND"',
		"xargs --max-lines 1 rm -rf ./build",
		"sudo --unknown-option value rm -rf ./build",
		"printf -v 'a[$(rm -rf ./build)0]' %s value",
		"declare 'a[$(rm -rf ./build)0]=value'",
		"mapfile -C 'rm -rf ./build; #' -c 1 <<< ok",
		'mapfile -t values <<< safe; declare values="$VALUE"',
		'readarray -t <<< safe; declare MAPFILE="$VALUE"',
		'printf -v "values[0]" %s safe; declare values="$VALUE"',
		'getopts x "values[0]" -x; declare values="$VALUE"',
		'local -I value="$VALUE"',
		"readarray -C 'rm -rf ./build; #' -c 1 <<< ok",
	])("does not turn an incomplete analysis into unattended permission: %s", async (command) => {
		for (const initialPreset of ["bypass", "autopilot"] as const) {
			const controller = new StepPermissionController({
				env: {},
				initialPreset,
				nonInteractiveApproval: "allow",
				toolOverrides: { run_command: "allow" },
			});
			expect(controller.decide("run_command", { command })).toMatchObject({
				action: "confirm",
				hazardous: false,
				analysisIncomplete: true,
			});
			const event: ToolCallEvent = {
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "incomplete-shell",
				input: { command },
			};
			expect(await controller.handleToolCall(event, { hasUI: false } as ExtensionContext)).toMatchObject({
				block: true,
				terminate: true,
			});
			const confirm = vi.fn(async () => false);
			expect(
				await controller.handleToolCall(event, { hasUI: true, ui: { confirm } } as unknown as ExtensionContext),
			).toMatchObject({ block: true });
			expect(confirm).toHaveBeenCalledWith(
				expect.stringMatching(/^Approve /u),
				expect.stringContaining("could not be fully analyzed"),
				expect.any(Object),
			);
		}
	});

	it("permits uncertain input only after explicit approval and keeps strict/deny precedence", async () => {
		const input = { command: 'bash -c "$SCRIPT"' };
		const event: ToolCallEvent = { type: "tool_call", toolName: "run_command", toolCallId: "review", input };
		const confirm = vi.fn(async () => true);
		const context = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
		const controller = new StepPermissionController({ env: {}, initialPreset: "bypass" });
		expect(await controller.handleToolCall(event, context)).toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
		for (const options of [
			{ initialPreset: "read-only" as const },
			{ initialPreset: "bypass" as const, toolOverrides: { run_command: "deny" as const } },
		]) {
			const denied = new StepPermissionController({ env: {}, ...options });
			expect(await denied.handleToolCall(event, context)).toMatchObject({ block: true, terminate: true });
		}
		expect(confirm).toHaveBeenCalledOnce();
	});
});
