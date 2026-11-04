import type { AgentToolResult } from "@step-harness/agent-core";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/index.ts";
import {
	registerStepClarifyUserExtension,
	type StepQuestionnaireDetails,
} from "../../../src/features/step-questionnaire.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/stepfun-ai/Step-Code/issues/311

type QuestionnaireComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

describe("clarify_user native TUI empty submission (#311)", () => {
	test("shows a validation error for an empty freeform answer and keeps the dialog open", async () => {
		let harness: Harness | undefined;

		try {
			harness = await createHarness({ extensionFactories: [registerStepClarifyUserExtension] });
			const tool = harness.session.extensionRunner
				.getAllRegisteredTools()
				.find(({ definition }) => definition.name === "clarify_user");
			if (!tool) throw new Error("clarify_user is not registered");

			const baseContext = harness.session.extensionRunner.createContext();
			let component: QuestionnaireComponent | undefined;
			let finishDialog: ((details: StepQuestionnaireDetails) => void) | undefined;
			const dialogResult = new Promise<StepQuestionnaireDetails>((resolve) => {
				finishDialog = resolve;
			});
			const fakeTui = {
				requestRender: () => {},
				terminal: { rows: 24 },
			} as unknown as never;
			const fakeTheme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				bg: (_color: string, text: string) => text,
			} as unknown as never;
			const context = {
				...baseContext,
				mode: "tui",
				hasUI: true,
				ui: {
					...baseContext.ui,
					custom: async (
						factory: (
							tui: never,
							theme: never,
							keybindings: never,
							done: (details: StepQuestionnaireDetails) => void,
						) => Promise<QuestionnaireComponent>,
					) => {
						component = await factory(fakeTui, fakeTheme, {} as never, (details) => {
							finishDialog?.(details);
						});
						return dialogResult;
					},
				},
			} as unknown as ExtensionContext;

			const execution = tool.definition.execute(
				"clarify-tui-empty",
				{ question: "Any notes?" },
				undefined,
				undefined,
				context,
			) as Promise<AgentToolResult<StepQuestionnaireDetails>>;

			await vi.waitFor(() => expect(component).toBeDefined());
			const dialog = component as QuestionnaireComponent;

			dialog.handleInput("\r");
			expect(dialog.render(80).join("\n")).toContain("Enter an answer before submitting");

			for (const character of "Fixed") dialog.handleInput(character);
			expect(dialog.render(80).join("\n")).not.toContain("Enter an answer before submitting");

			dialog.handleInput("\r");
			const result = await execution;
			expect(result.details).toMatchObject({
				cancelled: false,
				answers: [{ id: "answer", value: "Fixed", label: "Fixed", wasCustom: true }],
			});
		} finally {
			harness?.cleanup();
		}
	});
});
