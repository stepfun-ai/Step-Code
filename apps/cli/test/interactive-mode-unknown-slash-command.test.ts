import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

// Feedback issue-d59692496ef285c0: typing `/help` produced no error and was sent
// to the model as a prompt, because the submit handler had no fallback for a
// slash command that matched none of its hardcoded cases.
type UnknownCommandContext = {
	knownSlashCommandNames: Set<string>;
	session: { extensionRunner: { getCommand: (name: string) => unknown } };
};

type InteractiveModePrototype = {
	getUnknownSlashCommandName(this: UnknownCommandContext, text: string): string | undefined;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function contextWith(known: string[], extensionCommands: string[] = []): UnknownCommandContext {
	return {
		knownSlashCommandNames: new Set(known),
		session: {
			extensionRunner: {
				getCommand: (name: string) => (extensionCommands.includes(name) ? { name } : undefined),
			},
		},
	};
}

const check = (context: UnknownCommandContext, text: string): string | undefined =>
	prototype.getUnknownSlashCommandName.call(context, text);

describe("InteractiveMode.getUnknownSlashCommandName", () => {
	it("reports an unregistered command", () => {
		expect(check(contextWith(["model", "compact"]), "/help")).toBe("help");
	});

	it("reports the command name without its arguments", () => {
		expect(check(contextWith(["model"]), "/help me please")).toBe("help");
	});

	it("accepts a registered command", () => {
		expect(check(contextWith(["model"]), "/model step-3")).toBeUndefined();
	});

	it("accepts a skill command", () => {
		expect(check(contextWith(["skill:find-skills"]), "/skill:find-skills")).toBeUndefined();
	});

	it("accepts an extension command missing from autocomplete after a name collision", () => {
		expect(check(contextWith([], ["permissions"]), "/permissions --cycle")).toBeUndefined();
	});

	it("leaves an absolute path alone", () => {
		expect(check(contextWith(["model"]), "/tmp/report.md")).toBeUndefined();
	});

	it("leaves multi-line input alone", () => {
		expect(check(contextWith(["model"]), "/usr is where it lives\nsecond line")).toBeUndefined();
	});

	it("leaves a lone slash alone so autocomplete can open", () => {
		expect(check(contextWith(["model"]), "/")).toBeUndefined();
	});

	it("stays out of the way before the command set is built", () => {
		expect(check(contextWith([]), "/help")).toBeUndefined();
	});

	it("ignores text that is not a slash command", () => {
		expect(check(contextWith(["model"]), "help me")).toBeUndefined();
	});
});
