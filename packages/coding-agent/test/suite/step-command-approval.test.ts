import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStepExtension } from "../../src/features/step.ts";
import type { StepPermissionControllerOptions } from "../../src/step/permissions.ts";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const modes: Array<{ name: string; permission: StepPermissionControllerOptions }> = [
	{ name: "ask", permission: { initialPreset: "ask" } },
	{ name: "approve-for-me", permission: { initialPreset: "approve-for-me" } },
	{ name: "auto", permission: { approvalMode: "auto" } },
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

	async function setup(
		permission: StepPermissionControllerOptions,
		stepSettings?: () => {
			getStepSettings: () => Record<string, unknown>;
			setEffectiveStepSettings: (settings: Record<string, unknown>) => void;
		},
	): Promise<Harness> {
		harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["run_command"],
			extensionFactories: [
				createStepExtension({ permission: { env: {}, ...permission }, stepSettings }),
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

	it("full access runs the real deletion unattended without prompting", async () => {
		// The risk acknowledgment is what admits Full Access to a headless run;
		// without it the session falls back to Approve for Me (see below).
		const session = await setup(
			{
				initialPreset: "full-access",
				nonInteractiveApproval: "allow",
				toolOverrides: { run_command: "allow" },
			},
			() => ({
				getStepSettings: () => ({ fullAccessAcknowledged: true }),
				setEffectiveStepSettings: vi.fn(),
			}),
		);
		await session.session.bindExtensions({ mode: "print" });
		const marker = prepareRemoval(session, "full-access-removal");
		await session.session.prompt("Remove the test directory");
		expect(existsSync(marker)).toBe(false);
		expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: false,
		});
	});

	it("full access falls back to Approve for Me in a headless run without the acknowledgment", async () => {
		const session = await setup({
			initialPreset: "full-access",
			nonInteractiveApproval: "allow",
			toolOverrides: { run_command: "allow" },
		});
		await session.session.bindExtensions({ mode: "print" });
		const marker = prepareRemoval(session, "full-access-unacknowledged");
		await session.session.prompt("Remove the test directory");
		// Approve for Me still confirms the dangerous command, and no approval
		// channel exists in print mode.
		expect(existsSync(marker)).toBe(true);
		expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
	});

	it("full access still honors an explicit tool denial", async () => {
		const session = await setup(
			{
				initialPreset: "full-access",
				nonInteractiveApproval: "allow",
				toolOverrides: { run_command: "deny" },
			},
			() => ({
				getStepSettings: () => ({ fullAccessAcknowledged: true }),
				setEffectiveStepSettings: vi.fn(),
			}),
		);
		await session.session.bindExtensions({ mode: "print" });
		const marker = prepareRemoval(session, "full-access-denied");
		await session.session.prompt("Remove the test directory");
		expect(existsSync(marker)).toBe(true);
		expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
	});

	it("continues past a refused unattended deletion when denial recovery is enabled", async () => {
		const session = await setup({
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			nonInteractiveDenial: "continue",
			toolOverrides: { run_command: "allow" },
		});
		await session.session.bindExtensions({ mode: "print" });
		const marker = prepareRemoval(session, "recovered-removal");
		await session.session.prompt("Remove the test directory");
		expect(existsSync(marker)).toBe(true);
		expect(session.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
		});
		// The run keeps going: the follow-up assistant turn is consumed instead
		// of the batch terminating after the blocked call.
		expect(session.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(session)).toContain("done");
	});

	it("an explicit deny blocks the real tool without prompting", async () => {
		const session = await setup({
			initialPreset: "approve-for-me",
			toolOverrides: { run_command: "deny" },
		});
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
	});
});
