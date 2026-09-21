import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../src/core/extensions/types.ts";
import { isDangerousCommand } from "../src/step/command-policy.ts";
import {
	decideStepToolCall,
	STEP_PERMISSION_PRESETS,
	StepPermissionController,
	stepPermissionStateForPreset,
} from "../src/step/permissions.ts";

describe("mandatory command approval", () => {
	it.each([
		"rm -rf ./build",
		"rm -fr /tmp/cache",
		"rm -r -f project",
		"rm -f -R project",
		"rm --recursive --force project",
		"rm --force --recursive project",
		"rm -r --force project",
		"rm -Rf -- ./build",
		"rm ./build -rf",
		"rm -r ./build -f",
		"rm -rf",
		"rm -rf /",
		"rm -rf ~",
		'rm -rf "$TARGET"',
		"/bin/rm -rf ./build",
		"sudo -u root -- /bin/rm -rf ./build",
		"env MODE=test command rm -rf ./build",
		"env --chdir=/tmp rm -rf ./build",
		"env -C /tmp rm -rf ./build",
		"sudo --chdir=/tmp rm -rf ./build",
		"sudo -D /tmp rm -rf ./build",
		"sudo -h localhost rm -rf ./build",
		"sudo -nu root rm -rf ./build",
		"env --unset SECRET rm -rf ./build",
		">/tmp/output rm -rf ./build",
		"{fd}>/tmp/output rm -rf ./build",
		"rm>/tmp/output -rf ./build",
		"rm -r 2>/tmp/output -f ./build",
		"find . -exec rm -rf {} +",
		"find . -exec sh -c 'rm -rf ./build' \\;",
		"printf '%s' ./build | xargs rm -rf",
		"time rm -rf ./build",
		"cat <(rm -rf ./build)",
		"cat >(rm -rf ./build)",
		"exec rm -rf ./build",
		"nohup rm -rf ./build",
		"cd project && rm -rf ./build",
		"false || rm -rf ./build",
		"printf start; rm -rf ./build",
		"printf start\nrm -rf ./build",
		"rm -rf ./build | cat",
		"(rm -rf ./build)",
		"{ rm -rf ./build; }",
		"if true; then rm -rf ./build; fi",
		"sh -c 'rm -rf ./build'",
		"bash -lc 'rm -r -f ./build'",
		"sudo sh -c 'rm --recursive --force ./build'",
		"pwsh -Command rm -rf ./build",
		"powershell -c rm -rf ./build",
		'echo "$(rm -rf ./build)"',
		"echo `rm -rf ./build`",
		'echo "$(printf \'%s\' "$(rm -rf ./build)")"',
		'echo "$(echo ok # )\nrm -rf ./build\n)"',
		"cat <<EOF\n$(rm -rf ./build)\nEOF",
		"cat <<EOF\n'$(rm -rf ./build)'\nEOF",
		"sh <<'EOF'\nrm -rf ./build\nEOF",
		"sh <<EOF\n# $(rm -rf ./build)\nEOF",
		"sh <<EOF\n'$(rm -rf ./build)'\nEOF",
		"cat <<EOF | sh\n# $(rm -rf ./build)\nEOF",
		"cat <<'EOF' | sh\nrm -rf ./build\nEOF",
		"cat <<'EOF'\nsafe\nEOF\nrm -rf ./build",
		"r\\m '-rf' ./build",
		"rm -r\\\nf ./build",
		"rm \\\n-rf ./build",
	])("recognizes recursive forced removal: %s", (command) => {
		expect(isDangerousCommand(command)).toBe(true);
	});

	it.each([
		"rm -r ./build",
		"rm -f ./file",
		"rm --recursive ./build",
		"rm -rF ./build",
		"rm -- -rf",
		"rm -r -- -f",
		"echo rm -rf ./build",
		"printf '%s' 'rm -rf ./build'",
		"grep 'rm -rf' script.sh",
		"echo ok # cleanup; rm -rf ./build",
		"echo ok # $(rm -rf ./build)",
		"printf '%s' '$(rm -rf ./build)'",
		"printf '%s' '`rm -rf ./build`'",
		"sh -c '' 'rm -rf ./build'",
		"command -v rm -rf ./build",
		"command -V rm -rf ./build",
		"sudo -un root rm -rf ./build",
		"'2'>/tmp/output rm -rf ./build",
		"'{fd}'>/tmp/output rm -rf ./build",
		"cat <<'EOF'\nrm -rf ./build\nEOF",
		"cat <<'EOF'\n$(rm -rf ./build)\nEOF",
		"cat <<EOF\nrm -rf ./build\nEOF",
		"cat <<-EOF\n\trm -rf ./build\n\tEOF",
		"cat <<'FIRST' <<'SECOND'\nrm -rf ./first\nFIRST\nrm -rf ./second\nSECOND",
		"sh -c 'printf %s' label 'rm -rf ./build'",
		"qemu-system-x86_64 -no-reboot -no-shutdown",
	])("does not match unrelated arguments or incomplete flags: %s", (command) => {
		expect(isDangerousCommand(command)).toBe(false);
	});

	it.each([
		"mkfs.ext4 /dev/test",
		"dd if=image of=/dev/test",
		"git reset --hard",
		"sudo reboot",
		"sh -c 'shutdown now'",
	])("preserves existing hazardous commands: %s", (command) => {
		expect(isDangerousCommand(command)).toBe(true);
	});

	describe.each(STEP_PERMISSION_PRESETS)("$id policy", (preset) => {
		it.each(["run_command", "bash", "powershell"])("cannot auto-approve %s with an allow override", (toolName) => {
			const decision = decideStepToolCall(
				toolName,
				{ command: "rm -rf ./build" },
				stepPermissionStateForPreset(preset.id),
				{ [toolName]: "allow" },
			);
			expect(decision).toMatchObject({
				action: preset.mode === "strict" ? "deny" : "confirm",
				hazardous: true,
			});
		});

		it("blocks without an approval channel even with unattended allow", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: preset.id,
				nonInteractiveApproval: "allow",
				toolOverrides: { run_command: "allow" },
			});
			const event: ToolCallEvent = {
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "remove-build",
				input: { command: "rm -rf ./build", run_in_background: true },
			};
			const result = await controller.handleToolCall(event, { hasUI: false } as ExtensionContext);
			expect(result).toMatchObject({ block: true, terminate: true });
		});

		it("preserves explicit tool denial without offering approval", async () => {
			const controller = new StepPermissionController({
				env: {},
				initialPreset: preset.id,
				toolOverrides: { run_command: "deny" },
			});
			const confirm = vi.fn(async () => true);
			const event: ToolCallEvent = {
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "denied-removal",
				input: { command: "rm -rf ./build" },
			};
			const result = await controller.handleToolCall(event, {
				hasUI: true,
				ui: { confirm },
			} as unknown as ExtensionContext);
			expect(result).toMatchObject({ block: true, terminate: true });
			expect(confirm).not.toHaveBeenCalled();
		});

		it.each([true, false])("requires approval for each call (approved=%s)", async (approved) => {
			const controller = new StepPermissionController({ env: {}, initialPreset: preset.id });
			const confirm = vi.fn(async () => approved);
			const context = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
			for (const toolCallId of ["first-removal", "second-removal"]) {
				const event: ToolCallEvent = {
					type: "tool_call",
					toolName: "run_command",
					toolCallId,
					input: { command: "rm -rf ./build" },
				};
				const result = await controller.handleToolCall(event, context);
				if (preset.mode !== "strict" && approved) expect(result).toBeUndefined();
				else expect(result).toMatchObject({ block: true });
			}
			expect(confirm).toHaveBeenCalledTimes(preset.mode === "strict" ? 0 : 2);
		});
	});

	it.each(["command", "cmd", "script"])("checks the %s input field under auto mode", (key) => {
		const controller = new StepPermissionController({ env: {}, approvalMode: "auto" });
		expect(controller.decide("run_command", { [key]: "rm -rf ./build" })).toMatchObject({
			action: "confirm",
			hazardous: true,
		});
	});
});
