import { describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../src/core/tools/index.ts";

function createBuiltInTools() {
	return [
		createReadToolDefinition(process.cwd()),
		createBashToolDefinition(process.cwd()),
		createPowerShellToolDefinition(process.cwd()),
		createEditToolDefinition(process.cwd()),
		createWriteToolDefinition(process.cwd()),
	];
}

describe("built-in tool sampling defaults", () => {
	it("leaves constrained sampling unset", () => {
		for (const tool of createBuiltInTools()) {
			expect(tool.constrainedSampling).toBeUndefined();
		}
	});
});
