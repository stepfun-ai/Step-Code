import { Container, Text } from "@step-harness/pi-tui";
import { describe, expect, it } from "vitest";
import {
	keepLatestTaskUpdateResult,
	registerTaskUpdateCall,
	resetTaskUpdateTranscript,
} from "../src/ui/runtime/task-update-transcript.ts";

function add(container: Container, label: string): Text {
	const component = new Text(label, 0, 0);
	container.addChild(component);
	return component;
}

describe("task update transcript projection", () => {
	// Regression for GitHub issue #194.
	it("keeps later pending updates mounted during session replay", () => {
		const container = new Container();
		const first = add(container, "first");
		const second = add(container, "second");
		resetTaskUpdateTranscript(container);
		registerTaskUpdateCall(container, "first");
		registerTaskUpdateCall(container, "second");

		keepLatestTaskUpdateResult(container, "first", first, false);
		expect(container.children).toEqual([first, second]);

		keepLatestTaskUpdateResult(container, "second", second, false);
		expect(container.children).toEqual([second]);
	});

	// Regression for GitHub issue #194.
	it("keeps failed updates visible when a later update succeeds", () => {
		const container = new Container();
		const first = add(container, "first");
		const failed = add(container, "failed");
		const latest = add(container, "latest");
		resetTaskUpdateTranscript(container);
		registerTaskUpdateCall(container, "first");
		registerTaskUpdateCall(container, "failed");
		registerTaskUpdateCall(container, "latest");

		keepLatestTaskUpdateResult(container, "first", first, false);
		keepLatestTaskUpdateResult(container, "failed", failed, true);
		keepLatestTaskUpdateResult(container, "latest", latest, false);

		expect(container.children).toEqual([failed, latest]);
	});
});
