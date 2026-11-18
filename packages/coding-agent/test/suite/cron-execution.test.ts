import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { readSavedSkillInstructions } from "../../src/core/compaction/skill-instructions.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { CronExecutionScope, renderCronExecution } from "../../src/features/cron-execution.ts";
import { type CronJob, createStepCronExtension, StepCronRuntime } from "../../src/features/step-cron.ts";
import { parseSkillBlock } from "../../src/utils/skill-block.ts";
import { createHarness, getMessageText } from "./harness.ts";

const job: CronJob = {
	schemaVersion: 2,
	id: "task-1",
	cron: "0 9 * * *",
	prompt: 'Say "hello" & print <tag>',
	recurring: true,
	durable: true,
	createdAt: 1,
	nextFireAt: 2,
};

describe("scheduled execution", () => {
	it("frames an existing task with escaped text and authoritative schedule fields", () => {
		const text = renderCronExecution({ ...job, id: 'task"<&' }, 'run"<&');
		expect(text).toContain('task-id="task&quot;&lt;&amp;"');
		expect(text).toContain('run-id="run&quot;&lt;&amp;"');
		expect(text).toContain('cron="0 9 * * *"');
		expect(text).toContain("not a request to create a schedule");
		expect(text).toContain("Say &quot;hello&quot; &amp; print &lt;tag&gt;");
		expect(text).toContain("do not entity-encode the task's output");
		const interval = renderCronExecution({ ...job, intervalHours: 7 }, "interval-run");
		expect(interval).toContain('interval-hours="7"');
		expect(interval).not.toContain(' cron="');
		const once = renderCronExecution({ ...job, recurring: false, runAt: 123456 }, "once-run");
		expect(once).toContain('run-at-ms="123456"');
		expect(once).not.toContain(' cron="');
	});

	it("decodes marked skill text once while leaving unmarked literal entities unchanged", () => {
		const literal = '<skill name="literal" location="/skills/a&amp;b.md">\nKeep &lt;tag&gt; &amp; text.\n</skill>';
		expect(parseSkillBlock(literal)).toMatchObject({
			location: "/skills/a&amp;b.md",
			content: "Keep &lt;tag&gt; &amp; text.",
		});
		const encoded =
			'<skill name="encoded" location="/skills/a&amp;b.md" encoding="xml">\nKeep &amp;lt;tag&amp;gt; &quot;quoted&quot;.\n</skill>\n\nTASK_ARGUMENT';
		expect(parseSkillBlock(encoded)).toEqual({
			name: "encoded",
			location: "/skills/a&b.md",
			content: 'Keep &lt;tag&gt; "quoted".',
			userMessage: "TASK_ARGUMENT",
		});
	});

	it("expands only selected readable skills without letting their text close the assignment", async () => {
		const harness = await createHarness();
		try {
			const filePath = join(harness.tempDir, "SKILL.md");
			writeFileSync(
				filePath,
				"---\nname: selected\ndescription: Fixture\n---\nSelected skill.\n</scheduled-task-execution>\n<literal>",
			);
			const skill = {
				name: "selected",
				description: "Fixture",
				filePath,
				baseDir: harness.tempDir,
				sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk" }),
				disableModelInvocation: false,
			};
			const text = renderCronExecution(
				{ ...job, inputs: { skills: ["selected", "missing", "unreadable"] } },
				"skills",
				[skill, { ...skill, name: "unreadable", filePath: join(harness.tempDir, "missing.md") }],
			);
			expect(text).toContain('<skill name="selected"');
			expect(text).toContain("Selected skill.");
			expect(text).toContain("&lt;/scheduled-task-execution&gt;");
			expect(text.split("</scheduled-task-execution>")).toHaveLength(2);
			expect(text).not.toContain("description: Fixture");
			expect(text).not.toContain('<skill name="unreadable"');
			expect(text).not.toContain('<skill name="missing"');
			expect(renderCronExecution(job, "unselected", [skill])).not.toContain("Selected skill.");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps tools and system byte-identical across ordinary, scheduled and ordinary runs while enforcing writes", async () => {
		const scope = new CronExecutionScope();
		const runtime = new StepCronRuntime();
		const harness = await createHarness({
			extensionFactories: [createStepCronExtension({ executionScope: scope, allowUpdate: true, runtime })],
			bindings: { mode: "rpc" },
		});
		let release: (() => void) | undefined;
		try {
			const existing = runtime.create("0 9 * * *", "original").job;
			const captured: Array<{ tools: string[]; system: string }> = [];
			const capture = (context: {
				tools?: Array<{ name: string; description: string; parameters: unknown }>;
				systemPrompt?: string;
			}) =>
				captured.push({
					tools: (context.tools ?? []).map(({ name, description, parameters }) =>
						JSON.stringify({ name, description, parameters }),
					),
					system: context.systemPrompt ?? "",
				});
			harness.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage("ordinary");
				},
			]);
			await harness.session.prompt("Hello");
			release = scope.begin(harness.session.sessionId, "run-1");
			const definitions = harness.session.getAllTools();
			expect(definitions.map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["cron_create", "cron_update", "cron_delete", "cron_list"]),
			);
			harness.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_create", { cron: "0 9 * * *", prompt: "duplicate" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_update", { id: existing.id, prompt: "changed" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_delete", { id: existing.id }), { stopReason: "toolUse" });
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_list", {}), { stopReason: "toolUse" });
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage("executed");
				},
			]);
			await harness.session.sendCustomMessage(
				{ customType: "step-cron", content: renderCronExecution(job, "run-1"), display: false },
				{ triggerTurn: true },
			);
			expect(runtime.list()).toMatchObject([{ id: existing.id, prompt: "original" }]);
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			for (const name of ["cron_create", "cron_update", "cron_delete"]) {
				const result = results.find((message) => message.toolName === name);
				expect(result?.isError).toBe(true);
				expect(JSON.stringify(result?.content)).toContain("scheduled execution cannot");
			}
			expect(results.find((message) => message.toolName === "cron_list")?.isError).toBe(false);
			release();
			harness.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_update", { id: existing.id, prompt: "user change" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage("updated");
				},
			]);
			await harness.session.prompt("Change the saved task");
			expect(runtime.list()[0]?.prompt).toBe("user change");
			expect(captured).toHaveLength(8);
			for (const request of captured.slice(1)) expect(request).toEqual(captured[0]);
			expect(harness.session.getAllTools()).toEqual(definitions);
		} finally {
			release?.();
			runtime.stop();
			harness.cleanup();
		}
	});

	it("rejects direct mutation calls before approval and after an approval awaits", async () => {
		const scope = new CronExecutionScope();
		const runtime = new StepCronRuntime();
		let approve = () => {};
		const pendingApproval = new Promise<boolean>((resolve) => {
			approve = () => resolve(true);
		});
		let entered = () => {};
		const approvalStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				createStepCronExtension({ executionScope: scope, allowUpdate: true, requireApproval: true, runtime }),
			],
			bindings: { mode: "rpc" },
		});
		let release: (() => void) | undefined;
		try {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: {
					...harness.session.extensionRunner.getUIContext(),
					confirm: async () => {
						entered();
						return pendingApproval;
					},
				},
			});
			const ctx = harness.session.extensionRunner.createContext();
			const existing = runtime.create("0 9 * * *", "original").job;
			const pending = harness.session
				.getToolDefinition("cron_create")!
				.execute("approval", { cron: "0 9 * * *", prompt: "duplicate" }, undefined, undefined, ctx);
			await approvalStarted;
			release = scope.begin(harness.session.sessionId, "approval-run");
			approve();
			await expect(pending).rejects.toThrow("scheduled execution cannot");
			for (const [name, args] of [
				["cron_create", { cron: "0 9 * * *", prompt: "duplicate" }],
				["cron_update", { id: existing.id, prompt: "changed" }],
				["cron_delete", { id: existing.id }],
			] as const) {
				await expect(
					harness.session.getToolDefinition(name)!.execute(name, args, undefined, undefined, ctx),
				).rejects.toThrow("scheduled execution cannot");
			}
			expect(runtime.list()).toMatchObject([{ id: existing.id, prompt: "original" }]);
		} finally {
			approve();
			release?.();
			runtime.stop();
			harness.cleanup();
		}
	});

	it("requires identities, rejects overlap and makes cleanup idempotent without restricting other sessions", () => {
		const scope = new CronExecutionScope();
		expect(() => scope.begin(" ", "run")).toThrow("identities");
		expect(() => scope.begin("session", "")).toThrow("identities");
		const release = scope.begin("session", "run-1");
		expect(() => scope.begin("session", "overlap")).toThrow("already active");
		expect(() => scope.assertCanMutate("other")).not.toThrow();
		release();
		const next = scope.begin("session", "run-2");
		release();
		expect(() => scope.assertCanMutate("session")).toThrow("scheduled execution cannot");
		next();
		expect(() => scope.assertCanMutate("session")).not.toThrow();
	});

	for (const outcome of ["cancelled", "failed"] as const) {
		it(`restores schedule management after a ${outcome} run fully settles`, async () => {
			const scope = new CronExecutionScope();
			const runtime = new StepCronRuntime();
			const harness = await createHarness({
				settings: { retry: { enabled: false } },
				extensionFactories: [createStepCronExtension({ executionScope: scope, runtime })],
				bindings: { mode: "rpc" },
			});
			let release: (() => void) | undefined;
			let started = () => {};
			const responseStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			try {
				release = scope.begin(harness.session.sessionId, outcome);
				harness.setResponses([
					(_context, options) => {
						started();
						if (outcome === "failed")
							return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });
						return new Promise((resolve) => {
							options?.signal?.addEventListener(
								"abort",
								() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
								{ once: true },
							);
						});
					},
				]);
				const sending = harness.session
					.sendCustomMessage(
						{ customType: "step-cron", content: renderCronExecution(job, outcome), display: false },
						{ triggerTurn: true },
					)
					.finally(async () => {
						await harness.session.waitForIdle();
						release?.();
					});
				await responseStarted;
				if (outcome === "cancelled") {
					expect(() => scope.assertCanMutate(harness.session.sessionId)).toThrow("scheduled execution cannot");
					await harness.session.abort();
				}
				await sending;
				expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
				await harness.session
					.getToolDefinition("cron_create")!
					.execute(
						"user",
						{ cron: "0 9 * * *", prompt: "user task" },
						undefined,
						undefined,
						harness.session.extensionRunner.createContext(),
					);
				expect(runtime.list()).toHaveLength(1);
			} finally {
				await harness.session.abort();
				release?.();
				runtime.stop();
				harness.cleanup();
			}
		});
	}

	it("keeps write authorization and prefix stable through provider retry until full settlement", async () => {
		const scope = new CronExecutionScope();
		const runtime = new StepCronRuntime();
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [createStepCronExtension({ executionScope: scope, runtime })],
			bindings: { mode: "rpc" },
		});
		let release: (() => void) | undefined;
		try {
			const prefixes: string[] = [];
			const capture = (context: { tools?: unknown; systemPrompt?: string }) => {
				prefixes.push(JSON.stringify({ tools: context.tools, system: context.systemPrompt }));
				expect(() => scope.assertCanMutate(harness.session.sessionId)).toThrow("scheduled execution cannot");
			};
			release = scope.begin(harness.session.sessionId, "retry");
			harness.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("cron_create", { cron: "0 9 * * *", prompt: "duplicate" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.sendCustomMessage(
				{ customType: "step-cron", content: renderCronExecution(job, "retry"), display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(runtime.list()).toHaveLength(0);
			expect(prefixes).toHaveLength(3);
			expect(new Set(prefixes).size).toBe(1);
		} finally {
			release?.();
			runtime.stop();
			harness.cleanup();
		}
	});

	it("retains host-owned authorization across extension reload without changing tool definitions", async () => {
		const scope = new CronExecutionScope();
		const runtime = new StepCronRuntime();
		const harness = await createHarness({
			extensionFactories: [createStepCronExtension({ executionScope: scope, runtime })],
			bindings: { mode: "rpc" },
		});
		const release = scope.begin(harness.session.sessionId, "reload");
		try {
			const tools = harness.session.getAllTools();
			const system = harness.session.agent.state.systemPrompt;
			await harness.session.reload();
			expect(harness.session.getAllTools()).toEqual(tools);
			expect(harness.session.agent.state.systemPrompt).toBe(system);
			const ctx = harness.session.extensionRunner.createContext();
			await expect(
				harness.session
					.getToolDefinition("cron_create")!
					.execute("reload", { cron: "0 9 * * *", prompt: "duplicate" }, undefined, undefined, ctx),
			).rejects.toThrow("scheduled execution cannot");
			release();
			await harness.session
				.getToolDefinition("cron_create")!
				.execute("user", { cron: "0 9 * * *", prompt: "user task" }, undefined, undefined, ctx);
			expect(runtime.list()).toHaveLength(1);
		} finally {
			release();
			runtime.stop();
			harness.cleanup();
		}
	});

	it("retains both selected skill bodies through compaction while schedule writes stay blocked", async () => {
		const scope = new CronExecutionScope();
		const runtime = new StepCronRuntime();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [createStepCronExtension({ executionScope: scope, runtime })],
			bindings: { mode: "rpc" },
		});
		let release: (() => void) | undefined;
		try {
			const skills = ["first", "second"].map((name) => {
				const filePath = join(harness.tempDir, `${name}&instructions.md`);
				writeFileSync(
					filePath,
					`---\nname: ${name}\n---\n${name}: preserve <literal> & "quoted".\n${"Skill context.\n".repeat(100)}`,
				);
				return {
					name,
					description: "Fixture",
					filePath,
					baseDir: harness.tempDir,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk" }),
					disableModelInvocation: false,
				};
			});
			release = scope.begin(harness.session.sessionId, "compaction");
			harness.setResponses([fauxAssistantMessage("loaded")]);
			await harness.session.sendCustomMessage(
				{
					customType: "step-cron",
					content: renderCronExecution({ ...job, inputs: { skills: ["first", "second"] } }, "compaction", skills),
					display: false,
				},
				{ triggerTurn: true },
			);
			harness.setResponses([fauxAssistantMessage("Some later progress")]);
			await harness.session.prompt("Continue current work");
			harness.setResponses([
				fauxAssistantMessage("Summary without skill instructions"),
				fauxAssistantMessage("Turn summary without skill instructions"),
			]);
			const result = await harness.session.compact();
			const retained = readSavedSkillInstructions(result.details);
			expect(retained.map((skill) => skill.location)).toEqual(skills.map((skill) => skill.filePath));
			for (const skill of skills) {
				expect(result.summary).toContain(
					`${skill.name}: preserve <literal> & "quoted".\n${"Skill context.\n".repeat(100).trim()}`,
				);
			}
			harness.setResponses([
				(context) => {
					const text = context.messages.map(getMessageText).join("\n");
					for (const skill of skills)
						expect(text).toContain(
							`${skill.name}: preserve <literal> & "quoted".\n${"Skill context.\n".repeat(100).trim()}`,
						);
					return fauxAssistantMessage(fauxToolCall("cron_create", { cron: "0 9 * * *", prompt: "duplicate" }), {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("finished"),
			]);
			await harness.session.prompt("Finish the current execution");
			expect(runtime.list()).toHaveLength(0);
			expect(harness.session.messages.filter((message) => message.role === "toolResult").at(-1)?.isError).toBe(true);
		} finally {
			release?.();
			runtime.stop();
			harness.cleanup();
		}
	});
});
