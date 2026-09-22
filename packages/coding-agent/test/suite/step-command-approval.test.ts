import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStepExtension } from "../../src/features/step.ts";
import type { StepPermissionControllerOptions } from "../../src/step/permissions.ts";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { createHarness, type Harness } from "./harness.ts";

const modes: Array<{ name: string; permission: StepPermissionControllerOptions }> = [
	{ name: "ask", permission: { initialPreset: "ask" } },
	{ name: "bypass", permission: { initialPreset: "bypass" } },
	{ name: "auto", permission: { approvalMode: "auto" } },
	{ name: "autopilot", permission: { initialPreset: "autopilot" } },
];

describe("Step command approval through the agent loop", () => {
	let sandbox: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "step-command-approval-"));
		vi.stubEnv("STEP_CODING_AGENT_DIR", join(sandbox, "agent"));
	});

	afterEach(async () => {
		await harness?.session.abort();
		await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
		harness = undefined;
		rmSync(sandbox, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	async function setup(permission: StepPermissionControllerOptions): Promise<Harness> {
		harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["run_command"],
			extensionFactories: [
				createStepExtension({ permission: { env: {}, ...permission } }),
				(pi) => {
					const tool = createStepToolProfile(sandbox, { agentDir: join(sandbox, "agent") }).find(
						(candidate) => candidate.name === "run_command",
					);
					if (!tool) throw new Error("Step run_command tool is missing");
					pi.registerTool(tool);
				},
			],
		});
		return harness;
	}

	function prepareRemoval(session: Harness, toolCallId: string): string {
		const target = join(sandbox, "approval-target");
		mkdirSync(target, { recursive: true });
		const marker = join(target, "marker.txt");
		writeFileSync(marker, "test-owned marker");
		session.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_command", { command: "rm -rf -- ./approval-target", cwd: sandbox }, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		return marker;
	}

	it.each(modes)("$name waits for each decision before executing the real shell tool", async ({ permission }) => {
		const session = await setup({ ...permission, toolOverrides: { run_command: "allow" } });
		const pending: Array<(approved: boolean) => void> = [];
		const confirm = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
		await session.session.bindExtensions({
			mode: "tui",
			uiContext: { ...session.session.extensionRunner.getUIContext(), confirm },
		});

		for (const [index, approved] of [true, false].entries()) {
			const toolCallId = `removal-${index}`;
			const marker = prepareRemoval(session, toolCallId);
			const running = session.session.prompt("Remove the test directory");
			try {
				await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(index + 1));
				expect(existsSync(marker)).toBe(true);
				pending[index]!(approved);
				await running;
				expect(existsSync(marker)).toBe(!approved);
				expect(
					session.session.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
					),
				).toMatchObject({ isError: !approved });
			} finally {
				pending[index]?.(false);
				await session.session.abort();
				await running;
			}
		}
	});

	it.each(modes)("$name refuses unattended deletion even with allow overrides", async ({ permission }) => {
		const session = await setup({
			...permission,
			nonInteractiveApproval: "allow",
			toolOverrides: { run_command: "allow" },
		});
		await session.session.bindExtensions({ mode: "print" });
		const marker = prepareRemoval(session, "unattended-removal");
		await session.session.prompt("Remove the test directory");
		expect(existsSync(marker)).toBe(true);
		expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
	});

	it.each([
		{ name: "read-only", permission: { initialPreset: "read-only" } },
		{ name: "explicit deny", permission: { initialPreset: "bypass", toolOverrides: { run_command: "deny" } } },
	] satisfies Array<{ name: string; permission: StepPermissionControllerOptions }>)(
		"$name blocks the real tool without prompting",
		async ({ permission }) => {
			const session = await setup(permission);
			const confirm = vi.fn(async () => true);
			await session.session.bindExtensions({
				mode: "tui",
				uiContext: { ...session.session.extensionRunner.getUIContext(), confirm },
			});
			const marker = prepareRemoval(session, "denied-removal");
			await session.session.prompt("Remove the test directory");
			expect(existsSync(marker)).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
			expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
			});
		},
	);
});
