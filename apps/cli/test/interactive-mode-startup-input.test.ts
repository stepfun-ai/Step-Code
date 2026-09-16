import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	handleThinkingCommand: (searchTerm?: string) => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	stepWelcome?: { stopLogoIntro: () => void };
	// Reached by the bash and slash-command branches the intro test submits.
	handleBashCommand: (command: string, excluded: boolean) => Promise<void>;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	isBashMode: boolean;
	updateEditorBorderColor: () => void;
	// Used by the unregistered-slash-command guard the handler runs before the
	// bash, queue, and normal-submission branches.
	knownSlashCommandNames: Set<string>;
	getUnknownSlashCommandName: (text: string) => string | undefined;
	showError: (message: string) => void;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	getUnknownSlashCommandName(this: SubmitContext, text: string): string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		// Real implementation, with an empty command set so nothing is rejected.
		getUnknownSlashCommandName: function (this: SubmitContext, text: string) {
			return interactiveModePrototype.getUnknownSlashCommandName.call(this, text);
		},
		knownSlashCommandNames: new Set<string>(),
		showError: vi.fn(),
		handleThinkingCommand: vi.fn(),
		pendingUserInputs: [],
		stepWelcome: { stopLogoIntro: vi.fn() },
		handleBashCommand: vi.fn(async () => {}),
		handleModelCommand: vi.fn(async () => {}),
		isBashMode: false,
		updateEditorBorderColor: vi.fn(),
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it.each([" early prompt ", "!seq 1 400", "/model"])("ends the logo intro when %j is submitted", async (input) => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(input);

		expect(context.stepWelcome?.stopLogoIntro).toHaveBeenCalledOnce();
	});

	it("leaves the logo intro alone for an empty submission", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("   ");

		expect(context.stepWelcome?.stopLogoIntro).not.toHaveBeenCalled();
	});

	it.each([
		["/thinking", undefined],
		["/effort", undefined],
		["/thinking high", "high"],
		["/effort high", "high"],
	])("routes %s through the native thinking command handler", async (input, expectedSearchTerm) => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(input);

		expect(context.handleThinkingCommand).toHaveBeenCalledOnce();
		expect(context.handleThinkingCommand).toHaveBeenCalledWith(expectedSearchTerm);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
