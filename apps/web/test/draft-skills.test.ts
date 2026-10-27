/**
 * A draft's slash menu lists what a new session in that folder would load,
 * including the skills and commands of plugins installed a moment ago.
 * Plugins reach a session through an extension, which a draft does not run,
 * so the host adds the same plugin paths itself.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

const ENV_KEYS = ["HOME", "STEP_CODING_AGENT_DIR", "STEPCODE_STORAGE_ROOT_DIR", "STEPCODE_CONFIG_DIR"] as const;

test("a draft lists an installed plugin's skills and commands before any session starts", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-draft-skills-")));
	const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.HOME = join(base, "home");
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	// Plugins install under the storage root; keep them out of the developer's home.
	process.env.STEPCODE_STORAGE_ROOT_DIR = join(base, "storage");
	try {
		const workspace = join(base, "workspace");
		await mkdir(workspace, { recursive: true });
		await mkdir(join(base, "agent"), { recursive: true });
		const store = new WebSessionStore();
		const before = await store.slashResourcesFor(workspace);
		assert.equal(
			before.skills.some((skill) => skill.name === "fixture-skill"),
			false,
		);
		assert.equal(
			before.commands.some((command) => command.name === "fixture-review"),
			false,
		);

		// What an install leaves behind: a manifest, a skills folder and a commands folder.
		const plugin = join(base, "storage", "plugins", "fixture-plugin");
		await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
		await writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture-plugin" }));
		await mkdir(join(plugin, "skills", "fixture-skill"), { recursive: true });
		await writeFile(
			join(plugin, "skills", "fixture-skill", "SKILL.md"),
			"---\nname: fixture-skill\ndescription: A skill a plugin contributes.\n---\n\n# Fixture\n",
		);
		await mkdir(join(plugin, "commands"), { recursive: true });
		await writeFile(
			join(plugin, "commands", "fixture-review.md"),
			"---\ndescription: Review a pull request\nargument-hint: <pr>\n---\n\nReview pull request $1.\n",
		);
		// A template named like a kernel command never expands, so it is not offered.
		await writeFile(join(plugin, "commands", "goal.md"), "---\ndescription: Shadowed\n---\n\nNever runs.\n");

		const after = await store.slashResourcesFor(workspace);
		assert.deepEqual(
			after.skills.filter((skill) => skill.name === "fixture-skill"),
			[{ name: "fixture-skill", description: "A skill a plugin contributes." }],
		);
		assert.deepEqual(
			after.commands.filter((command) => command.name.startsWith("fixture-") || command.name === "goal"),
			[{ name: "fixture-review", description: "Review a pull request", argumentHint: "<pr>" }],
		);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(base, { recursive: true, force: true });
	}
});
