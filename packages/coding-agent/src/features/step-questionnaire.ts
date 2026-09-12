/** Step's single clarification tool, rendered with Pi's native TUI primitives. */

import type { AgentToolResult } from "@step-harness/agent-core";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@step-harness/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;

const ClarificationOptionSchema = Type.Object(
	{
		label: Type.String({ description: "User-facing option label" }),
		value: Type.String({ description: "Structured value returned on selection" }),
		description: Type.Optional(Type.String({ description: "Optional explanation shown below the label" })),
	},
	{ additionalProperties: false },
);

const ClarificationQuestionSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ description: "Stable answer id" })),
		label: Type.Optional(Type.String({ description: "Short navigation label" })),
		question: Type.String({ description: "The specific question to ask" }),
		reason: Type.Optional(Type.String({ description: "Why this answer is needed" })),
		options: Type.Optional(
			Type.Array(ClarificationOptionSchema, {
				maxItems: MAX_OPTIONS,
				description: "Suggested mutually exclusive answers",
			}),
		),
		allow_freeform: Type.Optional(
			Type.Boolean({
				description: "Allow a free-text answer in addition to listed options",
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * The legacy Step fields remain first-class. `questions` extends the same
 * contract to several prompts without exposing a second model-facing tool.
 */
const ClarifyUserSchema = Type.Object(
	{
		question: Type.Optional(Type.String({ description: "The specific question to ask the user" })),
		reason: Type.Optional(Type.String({ description: "Why this clarification is needed" })),
		options: Type.Optional(
			Type.Array(ClarificationOptionSchema, {
				maxItems: MAX_OPTIONS,
				description: "Suggested mutually exclusive answers",
			}),
		),
		allow_freeform: Type.Optional(
			Type.Boolean({
				description: "Allow a free-text answer; defaults to true",
			}),
		),
		questions: Type.Optional(
			Type.Array(ClarificationQuestionSchema, {
				minItems: 1,
				maxItems: MAX_QUESTIONS,
				description: "Several independent clarifications shown in one navigable dialog",
			}),
		),
	},
	{ additionalProperties: false },
);

type ClarifyUserParams = Static<typeof ClarifyUserSchema>;
type ClarificationOption = Static<typeof ClarificationOptionSchema>;

interface NormalizedQuestion {
	id: string;
	label: string;
	question: string;
	reason?: string;
	options: ClarificationOption[];
	allowFreeform: boolean;
}

type RenderOption = ClarificationOption & { isOther?: boolean };

export interface StepQuestionnaireAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface StepQuestionnaireDetails {
	questions: NormalizedQuestion[];
	answers: StepQuestionnaireAnswer[];
	cancelled: boolean;
}

function response(details: StepQuestionnaireDetails, text: string): AgentToolResult<StepQuestionnaireDetails> {
	return { content: [{ type: "text", text }], details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	const normalized = typeof value === "string" ? value.trim() : "";
	return normalized || undefined;
}

function normalizeOption(value: unknown): ClarificationOption | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		return text ? { label: text, value: text } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const label = stringValue(value.label);
	const optionValue = stringValue(value.value) ?? label;
	if (!label || !optionValue) return undefined;
	const description = stringValue(value.description);
	return { label, value: optionValue, ...(description ? { description } : {}) };
}

function normalizeOptions(value: unknown): ClarificationOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options = value
		.map(normalizeOption)
		.filter((option): option is ClarificationOption => option !== undefined)
		.slice(0, MAX_OPTIONS);
	return options.length > 0 ? options : undefined;
}

/** Accept calls produced by the previous askuser/questionnaire adapters. */
function prepareClarifyArguments(args: unknown): ClarifyUserParams {
	if (!isRecord(args)) return {};
	const questions = Array.isArray(args.questions)
		? args.questions
				.filter(isRecord)
				.slice(0, MAX_QUESTIONS)
				.map((question, index) => ({
					id: stringValue(question.id) ?? `q${index + 1}`,
					label: stringValue(question.label),
					question: stringValue(question.question) ?? stringValue(question.prompt) ?? `Question ${index + 1}`,
					reason: stringValue(question.reason),
					options: normalizeOptions(question.options),
					allow_freeform:
						typeof question.allow_freeform === "boolean"
							? question.allow_freeform
							: typeof question.allowOther === "boolean"
								? question.allowOther
								: undefined,
				}))
		: undefined;
	return {
		question: stringValue(args.question),
		reason: stringValue(args.reason),
		options: normalizeOptions(args.options),
		allow_freeform:
			typeof args.allow_freeform === "boolean"
				? args.allow_freeform
				: typeof args.allowFreeform === "boolean"
					? args.allowFreeform
					: undefined,
		...(questions && questions.length > 0 ? { questions } : {}),
	};
}

function normalizeQuestions(params: ClarifyUserParams): NormalizedQuestion[] {
	const raw = params.questions?.length
		? params.questions
		: params.question
			? [
					{
						id: "answer",
						label: "Question",
						question: params.question,
						reason: params.reason,
						options: params.options,
						allow_freeform: params.allow_freeform,
					},
				]
			: [];
	return raw.map((question, index) => ({
		id: question.id?.trim() || `q${index + 1}`,
		label: question.label?.trim() || `Q${index + 1}`,
		question: question.question.trim(),
		reason: question.reason?.trim() || undefined,
		options: (question.options ?? []).filter((option) => option.label.trim() && option.value.trim()),
		allowFreeform: question.allow_freeform !== false,
	}));
}

function answerText(questions: readonly NormalizedQuestion[], answers: readonly StepQuestionnaireAnswer[]): string {
	return answers
		.map((answer) => {
			const question = questions.find((candidate) => candidate.id === answer.id);
			const source = answer.wasCustom ? "freeform" : "option";
			return [
				`question: ${question?.question ?? answer.id}`,
				`answer: ${answer.value}`,
				`source: ${source}`,
				...(question?.reason ? [`reason: ${question.reason}`] : []),
				...(!answer.wasCustom ? [`matched_option: ${answer.label}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

async function executeFallback(
	questions: NormalizedQuestion[],
	ctx: ExtensionContext,
): Promise<StepQuestionnaireDetails> {
	const answers: StepQuestionnaireAnswer[] = [];
	for (const question of questions) {
		if (question.options.length === 0) {
			const answer = await ctx.ui.input(question.question);
			if (answer === undefined) return { questions, answers, cancelled: true };
			answers.push({
				id: question.id,
				value: answer,
				label: answer,
				wasCustom: true,
			});
			continue;
		}
		const labels = question.options.map((option) => option.label);
		if (question.allowFreeform) labels.push("Type a custom answer");
		const selected = await ctx.ui.select(question.question, labels);
		if (selected === undefined) return { questions, answers, cancelled: true };
		const index = labels.indexOf(selected);
		if (index === question.options.length) {
			const answer = await ctx.ui.input(question.question);
			if (answer === undefined) return { questions, answers, cancelled: true };
			answers.push({
				id: question.id,
				value: answer,
				label: answer,
				wasCustom: true,
			});
			continue;
		}
		const option = question.options[index];
		if (!option) return { questions, answers, cancelled: true };
		answers.push({
			id: question.id,
			value: option.value,
			label: option.label,
			wasCustom: false,
			index: index + 1,
		});
	}
	return { questions, answers, cancelled: false };
}

async function executeNativeDialog(
	questions: NormalizedQuestion[],
	ctx: ExtensionContext,
): Promise<StepQuestionnaireDetails> {
	return ctx.ui.custom<StepQuestionnaireDetails>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = questions[0]?.options.length === 0;
		let inputQuestionId: string | null = inputMode ? (questions[0]?.id ?? null) : null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, StepQuestionnaireAnswer>();
		const totalTabs = questions.length + 1;
		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = (): void => {
			cachedLines = undefined;
			tui.requestRender();
		};
		const submit = (cancelled: boolean): void => {
			done({ questions, answers: [...answers.values()], cancelled });
		};
		const currentQuestion = (): NormalizedQuestion | undefined => questions[currentTab];
		const currentOptions = (): RenderOption[] => {
			const question = currentQuestion();
			if (!question) return [];
			const options: RenderOption[] = [...question.options];
			if (question.allowFreeform) {
				options.push({
					label: "Type a custom answer",
					value: "__other__",
					isOther: true,
				});
			}
			return options;
		};
		const allAnswered = (): boolean => questions.every((question) => answers.has(question.id));
		const activateTab = (next: number): void => {
			currentTab = (next + totalTabs) % totalTabs;
			optionIndex = 0;
			const question = currentQuestion();
			inputMode = Boolean(question && question.options.length === 0);
			inputQuestionId = inputMode ? (question?.id ?? null) : null;
			editor.setText("");
			refresh();
		};
		const advance = (): void => {
			if (questions.length === 1) {
				submit(false);
				return;
			}
			activateTab(currentTab + 1);
		};
		const saveAnswer = (
			questionId: string,
			value: string,
			label: string,
			wasCustom: boolean,
			index?: number,
		): void => {
			answers.set(questionId, {
				id: questionId,
				value,
				label,
				wasCustom,
				...(index !== undefined ? { index } : {}),
			});
		};

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const answer = value.trim();
			if (!answer) return;
			saveAnswer(inputQuestionId, answer, answer, true);
			editor.setText("");
			inputMode = false;
			inputQuestionId = null;
			advance();
		};

		const handleInput = (data: string): void => {
			if (matchesKey(data, Key.escape)) {
				if (inputMode && currentQuestion()?.options.length) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
				} else {
					submit(true);
				}
				return;
			}
			if (matchesKey(data, Key.tab)) {
				activateTab(currentTab + 1);
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				activateTab(currentTab - 1);
				return;
			}
			if (inputMode) {
				editor.handleInput(data);
				refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				activateTab(currentTab + 1);
				return;
			}
			if (matchesKey(data, Key.left)) {
				activateTab(currentTab - 1);
				return;
			}
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				return;
			}
			const question = currentQuestion();
			const options = currentOptions();
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(Math.max(0, options.length - 1), optionIndex + 1);
				refresh();
				return;
			}
			const numericIndex = /^[1-9]$/u.test(data) ? Number(data) - 1 : -1;
			const selectedIndex = numericIndex >= 0 && numericIndex < options.length ? numericIndex : optionIndex;
			if (!question || (!matchesKey(data, Key.enter) && numericIndex === -1)) {
				return;
			}
			const selected = options[selectedIndex];
			if (!selected) return;
			if (selected.isOther) {
				inputMode = true;
				inputQuestionId = question.id;
				editor.setText("");
				refresh();
				return;
			}
			saveAnswer(question.id, selected.value, selected.label, false, selectedIndex + 1);
			advance();
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];
			const question = currentQuestion();
			const options = currentOptions();
			const addWrapped = (prefix: string, value: string): void => {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					lines.push(...wrapTextWithAnsi(`${prefix}${value}`, renderWidth));
					return;
				}
				const wrapped = wrapTextWithAnsi(value, renderWidth - prefixWidth);
				for (const [index, line] of wrapped.entries()) {
					lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
				}
			};

			lines.push(theme.fg("accent", "-".repeat(renderWidth)));
			if (currentTab < questions.length) {
				addWrapped(
					" ",
					`${theme.bold(`Question ${currentTab + 1}/${questions.length}`)}  ${theme.fg("muted", question?.label ?? "")}`,
				);
			} else {
				addWrapped(" ", theme.bold(`Review answers (${questions.length})`));
			}
			const navigation = questions
				.map((candidate, index) => {
					const marker = answers.has(candidate.id) ? "[x]" : "[ ]";
					const text = `${marker} ${index + 1}`;
					return index === currentTab
						? theme.bg("selectedBg", theme.fg("text", ` ${text} `))
						: theme.fg(answers.has(candidate.id) ? "success" : "muted", text);
				})
				.join("  ");
			addWrapped(
				" ",
				`${navigation}  ${currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", " Submit ")) : theme.fg(allAnswered() ? "success" : "dim", "Submit")}`,
			);
			lines.push("");

			if (currentTab === questions.length) {
				for (const candidate of questions) {
					const answer = answers.get(candidate.id);
					addWrapped(
						" ",
						`${theme.fg("muted", `${candidate.label}: `)}${answer ? theme.fg("text", answer.label) : theme.fg("warning", "unanswered")}`,
					);
				}
				lines.push("");
				addWrapped(
					" ",
					allAnswered()
						? theme.fg("success", "Enter to submit")
						: theme.fg("warning", "Answer every question before submitting"),
				);
			} else if (question) {
				addWrapped(" ", theme.fg("text", question.question));
				if (question.reason) {
					addWrapped(" ", theme.fg("muted", question.reason));
				}
				lines.push("");
				for (const [index, option] of options.entries()) {
					const selected = index === optionIndex;
					addWrapped(
						selected ? theme.fg("accent", "> ") : "  ",
						theme.fg(selected ? "accent" : "text", `${index + 1}. ${option.label}`),
					);
					if (option.description) {
						addWrapped("     ", theme.fg("muted", option.description));
					}
				}
				if (inputMode) {
					if (options.length > 0) lines.push("");
					addWrapped(" ", theme.fg("muted", "Your answer:"));
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
				}
			}

			lines.push("");
			addWrapped(
				" ",
				theme.fg(
					"dim",
					inputMode
						? "Enter answer | Tab/Shift+Tab switch | Esc cancel"
						: "Tab or Left/Right switch | Up/Down select | Enter confirm | Esc cancel",
				),
			);
			lines.push(theme.fg("accent", "-".repeat(renderWidth)));
			cachedLines = lines;
			return lines;
		};

		return {
			render,
			handleInput,
			invalidate: () => {
				cachedLines = undefined;
			},
		};
	});
}

async function executeQuestionnaire(
	params: ClarifyUserParams,
	ctx: ExtensionContext,
	telemetry?: StepTelemetryReporter,
): Promise<AgentToolResult<StepQuestionnaireDetails>> {
	const questions = normalizeQuestions(params);
	if (!ctx.hasUI || ctx.mode !== "tui") {
		return response({ questions, answers: [], cancelled: true }, "Error: clarify_user requires an interactive UI");
	}
	if (questions.length === 0 || questions.some((item) => !item.question)) {
		return response({ questions, answers: [], cancelled: true }, "Error: provide question or questions[]");
	}
	if (questions.some((item) => item.options.length === 0 && !item.allowFreeform)) {
		return response(
			{ questions, answers: [], cancelled: true },
			"Error: allow_freeform=false requires at least one option",
		);
	}

	const askedAt = Date.now();
	const details =
		typeof ctx.ui.custom === "function"
			? await executeNativeDialog(questions, ctx)
			: await executeFallback(questions, ctx);
	const outcome = details.cancelled
		? "cancelled"
		: details.answers.some((answer) => answer.wasCustom)
			? "freeform"
			: "option";
	if (telemetry) {
		trackStepTelemetry(telemetry, "clarification_resolved", {
			outcome,
			option_count: questions.reduce((count, question) => count + question.options.length, 0),
			duration_ms: Math.max(0, Date.now() - askedAt),
		});
	}
	return details.cancelled
		? response(details, "User clarification cancelled")
		: response(details, answerText(questions, details.answers));
}

export function registerStepClarifyUserExtension(pi: ExtensionAPI, telemetry?: StepTelemetryReporter): void {
	pi.registerTool<typeof ClarifyUserSchema, StepQuestionnaireDetails>({
		name: "clarify_user",
		label: "Clarify user",
		description:
			"Ask the user only when a genuine user-owned decision blocks progress. Use question/reason/options/allow_freeform for one question, or questions[] to collect several answers in one navigable dialog.",
		promptSnippet: "Ask the user for a blocking clarification",
		parameters: ClarifyUserSchema,
		prepareArguments: prepareClarifyArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => executeQuestionnaire(params, ctx, telemetry),
		renderCall: (params, theme) => {
			const count = params.questions?.length ?? (params.question ? 1 : 0);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("clarify_user "))}${theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`)}`,
				0,
				0,
			);
		},
		renderResult: (result, _options, theme) => {
			const details = result.details;
			if (!details) {
				const block = result.content.find((item) => item.type === "text");
				return new Text(block?.type === "text" ? block.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Clarification cancelled"), 0, 0);
			}
			return new Text(
				details.answers
					.map(
						(answer, index) =>
							`${theme.fg("success", "+")} ${theme.fg("accent", `${index + 1}/${details.questions.length}`)} ${answer.label}`,
					)
					.join("\n"),
				0,
				0,
			);
		},
	});
}

/** Retained as a source-level alias for embedders; only clarify_user is registered. */
export const registerStepQuestionnaireExtension = registerStepClarifyUserExtension;

export const stepQuestionnaireExtension: ExtensionFactory = (pi: ExtensionAPI): void => {
	registerStepClarifyUserExtension(pi);
};
