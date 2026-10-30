/**
 * Session modes are single-shot: a mode rides one message and is consumed.
 *
 * Picking one used to type `/ultraloop on`, `/goal clear` or a bare `/plan` into
 * the prompt and keep it on for the session, so switching one off took a second
 * command and the input showed keywords the user never wrote.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chooseMode, clearModes, modePrefix } from "../client/src/features/composer/actions.ts";
import { commandLeadIcon, MODES, modeFromCommand, PICKABLE_MODES } from "../client/src/features/composer/modes.ts";
import { MESSAGES } from "../client/src/i18n/messages.ts";
import { createInitialState, getState, setState, type ModeId } from "../client/src/state/store.ts";

function reset(): void {
	const initial = createInitialState();
	setState({ modes: { ...initial.modes } });
}

test("picking a mode stages no text in the prompt", () => {
	reset();
	// The return value is only "is it on"; nothing is written into the composer.
	for (const id of ["goal", "plan", "ultraloop"] as ModeId[]) {
		assert.equal(chooseMode(id), true);
		assert.equal(getState().modes[id], true);
	}
});

test("modes are single-select: picking one clears the others", () => {
	reset();
	chooseMode("goal");
	chooseMode("plan");
	assert.deepEqual(getState().modes, { goal: false, plan: true, ultraloop: false });
});

test("picking an active mode again removes it without sending a clear command", () => {
	reset();
	chooseMode("ultraloop");
	assert.equal(chooseMode("ultraloop"), false);
	assert.deepEqual(getState().modes, { goal: false, plan: false, ultraloop: false });
});

test("each mode maps to the prefix the kernel reads for one turn", () => {
	// `/goal <body>` starts a goal, `/plan <body>` plans that task, and the
	// `ultracode:` keyword is the kernel's own per-turn workflow opt-in
	// (`ultraloop` is its alias and the kernel matches both).
	assert.equal(modePrefix("goal"), "/goal ");
	assert.equal(modePrefix("plan"), "/plan ");
	assert.match(modePrefix("ultraloop"), /^ultracode: ?$/u);
});

test("sending consumes every staged mode", () => {
	reset();
	chooseMode("goal");
	clearModes();
	assert.deepEqual(getState().modes, { goal: false, plan: false, ultraloop: false });
});

test("each mode carries its icon, labels and placeholder in every locale", () => {
	// The staged-mode presentation reads one metadata entry per mode; a key
	// missing from either locale would render as its key string.
	assert.deepEqual(
		MODES.map((mode) => mode.id),
		["goal", "plan", "ultraloop"],
	);
	for (const mode of MODES) {
		assert.ok(mode.icon, `${mode.id}: no icon`);
		for (const key of [mode.labelKey, mode.descKey, mode.placeholderKey]) {
			assert.ok(Object.hasOwn(MESSAGES["zh-CN"], key), `${mode.id}: zh-CN missing ${key}`);
			assert.ok(Object.hasOwn(MESSAGES["en-US"], key), `${mode.id}: en-US missing ${key}`);
		}
	}
});

test("each mode has its accent and lead theme in composer.css", () => {
	// A mode is one metadata entry plus its CSS accent (see modes.ts): the card
	// paints through `[data-mode]` (its --mode-accent also colours the chip),
	// and the ＋ menu row through its per-mode class. Lead chips render in the
	// sent format's own look — one shared rule, no per-mode chip theming.
	const css = readFileSync(new URL("../client/src/features/composer/composer.css", import.meta.url), "utf8");
	for (const mode of MODES) {
		assert.ok(css.includes(`[data-mode="${mode.id}"]`), `${mode.id}: no composer-card accent block`);
		assert.ok(css.includes(".control-option--" + mode.id), `${mode.id}: no ＋ menu row class`);
	}
	assert.ok(css.includes(".prompt-mode"), "no mode lead chip rule");
	assert.ok(css.includes(".prompt-command"), "no plain-command lead chip rule");
	// Plain leading commands share the lead shape through their own class.
	assert.ok(css.includes(".prompt-command"), "no plain-command lead class");
});

test("ultracode is hidden from the picker while its command keeps working", () => {
	// Web and Desktop do not offer the mode until its interaction is finished,
	// but nothing behind it was removed: the keyword still stages the same mode,
	// the same kernel prefix, and its chip keeps its own label and placeholder.
	assert.equal(MODES.find((mode) => mode.id === "ultraloop")?.hidden, true);
	assert.deepEqual(
		PICKABLE_MODES.map((mode) => mode.id),
		["goal", "plan"],
	);
	assert.equal(modeFromCommand("ultracode"), "ultraloop");
	assert.equal(modeFromCommand("ultraloop"), "ultraloop");
	assert.equal(modePrefix("ultraloop"), "ultracode: ");
});

test("the mode commands stage their mode; the keyword form maps to the same mode", () => {
	// Typing `/goal`, `/plan` or the ultraloop keyword renders the same chip as
	// picking the mode from the ＋ menu; every other command stays a plain lead.
	assert.equal(modeFromCommand("goal"), "goal");
	assert.equal(modeFromCommand("plan"), "plan");
	assert.equal(modeFromCommand("ultraloop"), "ultraloop");
	assert.equal(modeFromCommand("ultracode"), "ultraloop");
	assert.equal(modeFromCommand("feedback"), null);
	assert.equal(modeFromCommand("skill:foo"), null);
});

test("each leading command keeps one icon across typings and menu picks", () => {
	assert.equal(commandLeadIcon("skill:foo"), "wrench");
	assert.equal(commandLeadIcon("plugin"), "puzzle");
	assert.equal(commandLeadIcon("permissions"), "shield");
	assert.equal(commandLeadIcon("btw"), "question");
	assert.equal(commandLeadIcon("feedback"), "thumbsUp");
	assert.equal(commandLeadIcon("compact"), "prompt");
});
