import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalWorkspacePath, WorkspaceRegistry } from "../src/workspaces.ts";
import { WebSessionStore } from "../src/runtime.ts";

test("workspaces persist across registry instances and can be removed", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-workspaces-")));
	try {
		const file = join(base, "agent", "web-workspaces.json");
		const folder = join(base, "project");
		await mkdir(folder);
		const registry = new WorkspaceRegistry(file);
		assert.deepEqual(await registry.list(), []);

		assert.deepEqual(await registry.add(folder), { path: folder, name: "project", available: true });
		// Adding the same folder twice, even spelled differently, lists it once.
		await registry.add(join(folder, "..", "project"));
		assert.equal((await registry.list()).length, 1);

		const reopened = new WorkspaceRegistry(file);
		assert.deepEqual(await reopened.list(), [{ path: folder, name: "project", available: true }]);
		assert.equal(await reopened.has(folder), true);

		await rm(folder, { recursive: true });
		assert.equal((await reopened.list())[0]?.available, false);

		assert.equal(await reopened.remove(folder), true);
		assert.equal(await reopened.remove(folder), true);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { workspaces: [], removedWorkspaces: [folder] });
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("the most recently added workspace is listed first", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-workspaces-")));
	try {
		const registry = new WorkspaceRegistry(join(base, "web-workspaces.json"));
		for (const name of ["first", "second"]) await mkdir(join(base, name));
		await registry.add(join(base, "first"));
		await registry.add(join(base, "second"));
		assert.deepEqual(
			(await registry.list()).map((workspace) => workspace.name),
			["second", "first"],
		);
		// Adding a listed folder again moves it back to the top.
		await registry.add(join(base, "first"));
		assert.deepEqual(
			(await registry.list()).map((workspace) => workspace.name),
			["first", "second"],
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("only existing directories can be registered", async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-workspaces-"));
	try {
		const registry = new WorkspaceRegistry(join(base, "web-workspaces.json"));
		await writeFile(join(base, "file.txt"), "x");
		await assert.rejects(registry.add(join(base, "missing")), /does not exist/);
		await assert.rejects(registry.add(join(base, "file.txt")), /not a directory/);
		await assert.rejects(registry.add("  "), /path is required/);
		assert.deepEqual(await registry.list(), []);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a malformed registry file starts empty instead of failing", async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-workspaces-"));
	try {
		const file = join(base, "web-workspaces.json");
		await writeFile(file, "{not json");
		assert.deepEqual(await new WorkspaceRegistry(file).list(), []);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("removing a session-derived workspace persists, preserves files, and can be restored", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-removal-")));
	try {
		const file = join(base, "web-workspaces.json");
		const folder = join(base, "project");
		await mkdir(folder);
		await writeFile(join(folder, "keep.txt"), "keep");
		const registry = new WorkspaceRegistry(file);
		assert.equal(await registry.remove(folder), true);
		const reopened = new WorkspaceRegistry(file);
		assert.deepEqual(await reopened.list(), [{ path: folder, name: "project", available: true, hidden: true }]);
		assert.equal(await reopened.has(folder), false);
		assert.equal(await readFile(join(folder, "keep.txt"), "utf8"), "keep");
		await reopened.add(folder);
		assert.deepEqual(await new WorkspaceRegistry(file).list(), [{ path: folder, name: "project", available: true }]);
		assert.equal(await reopened.has(folder), true);
		assert.equal(await reopened.remove(""), false);
		assert.equal(await reopened.remove("relative/path"), false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("failed persistence leaves removal and restoration retryable", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-removal-retry-")));
	try {
		const file = join(base, "web-workspaces.json");
		const registry = new WorkspaceRegistry(file);
		await registry.add(base);
		await mkdir(`${file}.${process.pid}.tmp`);
		await assert.rejects(registry.remove(base));
		assert.equal(await registry.has(base), true);
		await rm(`${file}.${process.pid}.tmp`, { recursive: true });
		await registry.remove(base);
		await mkdir(`${file}.${process.pid}.tmp`);
		await assert.rejects(registry.add(base));
		assert.equal(await registry.has(base), false);
		await rm(`${file}.${process.pid}.tmp`, { recursive: true });
		await registry.add(base);
		assert.equal(await new WorkspaceRegistry(file).has(base), true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

/**
 * A folder reaches this registry under more than one name: a symlink, macOS's
 * `/var` and `/private/var`, a launcher's trailing slash. Two spellings are one
 * workspace, so removing it under either name has to hide it — otherwise it
 * stays in the sidebar and in the composer's list, and using it is refused by
 * the host as "not a known workspace".
 */
test("removing a workspace by another spelling of its folder hides it", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-spelling-")));
	try {
		const file = join(base, "web-workspaces.json");
		const folder = join(base, "project");
		await mkdir(folder);
		const registry = new WorkspaceRegistry(file);
		const added = await registry.add(folder);

		// The second name a session or a launcher would carry for the same folder.
		const link = join(base, "project-link");
		await symlink(folder, link);
		const alternate = await realpath(link);
		assert.equal(alternate, added.path);

		await registry.remove(link);

		// After a reload, as the page does.
		const reopened = new WorkspaceRegistry(file);
		const listed = await reopened.list();
		assert.deepEqual(
			listed.filter((workspace) => !workspace.hidden),
			[],
			"the workspace is still listed after being removed under another spelling",
		);
		assert.equal(await reopened.has(folder), false, "the folder is still a known workspace");
		assert.equal(await reopened.has(link), false);

		// Removing again is a no-op, and re-registering restores it.
		assert.equal(await reopened.remove(link), true);
		await reopened.add(folder);
		assert.deepEqual(
			(await new WorkspaceRegistry(file).list()).filter((workspace) => !workspace.hidden).map((w) => w.path),
			[added.path],
		);
		assert.equal(await reopened.has(link), true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a registry file left with one spelling visible and another hidden is repaired on read", async () => {
	// Exactly what the previous version wrote when a workspace was removed under
	// an alternate spelling: the registered entry stayed visible forever.
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-repair-")));
	try {
		const file = join(base, "web-workspaces.json");
		const folder = join(base, "project");
		await mkdir(folder);
		// The two entries are different strings for one folder; `path.join` would
		// normalize them back together, so the file is written verbatim.
		await writeFile(
			file,
			JSON.stringify({ workspaces: [folder], removedWorkspaces: [`${folder}/.`] }, null, 2),
		);
		const listed = await new WorkspaceRegistry(file).list();
		assert.deepEqual(
			listed.filter((workspace) => !workspace.hidden).map((workspace) => workspace.path),
			[],
			"the stale visible entry survived the read",
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a folder recorded under two spellings is listed once", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-duplicate-")));
	try {
		const file = join(base, "web-workspaces.json");
		const folder = join(base, "project");
		await mkdir(folder);
		const link = join(base, "project-link");
		await symlink(folder, link);
		// A file written by an older build could hold both names.
		await writeFile(file, JSON.stringify({ workspaces: [folder, link], removedWorkspaces: [] }, null, 2));
		const listed = await new WorkspaceRegistry(file).list();
		assert.equal(listed.filter((workspace) => !workspace.hidden).length, 1);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a launch folder reached through a symlink is reported under its real path", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-canonical-")));
	try {
		const real = join(base, "project");
		const link = join(base, "shortcut");
		await mkdir(real);
		await symlink(real, link);
		// `bootstrap.cwd` names the page's launch folder. The registry stores and
		// removes resolved paths, so a symlinked launch spelling listed the removed
		// folder in the composer's picker again, on this page and after a reload.
		assert.equal(await canonicalWorkspacePath(link), real);
		assert.equal(await canonicalWorkspacePath(join(real, "..", "project")), real);
		// A folder that is gone keeps the only spelling left, so its recorded
		// removal still matches.
		const missing = join(base, "gone");
		assert.equal(await canonicalWorkspacePath(missing), missing);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a session recorded through a symlink is listed under the registry's spelling", async () => {
	// The client matches a removed folder against the spelling its session rows
	// carry, so the listing has to report the real path: a session recorded
	// through a symlink kept that spelling, and its project group survived the
	// removal of the folder it actually named. This locks the host-side
	// resolution the client's string compare depends on.
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-session-cwd-")));
	const previousAgentDir = process.env.STEP_CODING_AGENT_DIR;
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	try {
		const real = join(base, "project");
		const link = join(base, "shortcut");
		await mkdir(real);
		await symlink(real, link);
		// The directory name is only a container; the listing reads the header's cwd.
		const directory = join(base, "agent", "sessions", "symlinked");
		await mkdir(directory, { recursive: true });
		const timestamp = new Date().toISOString();
		await writeFile(
			join(directory, "session.jsonl"),
			[
				{ type: "session", version: 3, id: "s1", timestamp, cwd: link },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp,
					message: { role: "user", content: "hello", timestamp: Date.now() },
				},
			]
				.map((line) => JSON.stringify(line))
				.join("\n") + "\n",
		);
		const listed = await new WebSessionStore().list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].cwd, real, "the row carries the real path, the spelling the registry stores");
		assert.equal(listed[0].cwdAvailable, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
		else process.env.STEP_CODING_AGENT_DIR = previousAgentDir;
		await rm(base, { recursive: true, force: true });
	}
});
