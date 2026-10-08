import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureStepShellPath } from "../src/step/shell-path.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "step-shell-path-"));
	roots.push(root);
	const bin = join(root, "custom bin");
	const env = { HOME: root, SHELL: "/bin/zsh", PATH: `${bin}:/usr/bin:/bin` };
	return { root, bin, env, input: { env, executablePath: join(bin, "step"), platform: "darwin" as const } };
}

test.skipIf(process.platform === "win32")(
	"persists an inherited PATH for fresh shells and stays idempotent",
	async () => {
		const f = await fixture();
		const profile = join(f.root, ".zshrc");
		await writeFile(profile, "export UNRELATED=preserve\n");
		expect(await ensureStepShellPath(f.input)).toEqual([]);
		const first = await readFile(profile, "utf8");
		expect(await ensureStepShellPath(f.input)).toEqual([]);
		expect(await readFile(profile, "utf8")).toBe(first);
		expect(first).toContain("export UNRELATED=preserve");
		const result = await execFileAsync("/bin/sh", ["-c", '. "$1"; . "$1"; printf "%s" "$PATH"', "test", profile], {
			env: { HOME: f.root, PATH: "/usr/bin:/bin" },
		});
		expect(result.stdout.split(":").filter((entry) => entry === f.bin)).toHaveLength(1);
	},
);

test("respects explicit PATH opt-out", async () => {
	const f = await fixture();
	expect(await ensureStepShellPath({ ...f.input, env: { ...f.env, STEP_NO_MODIFY_PATH: "1" } })).toEqual([]);
	await expect(readFile(join(f.root, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("updates only managed blocks when moving an existing installation", async () => {
	const f = await fixture();
	const profile = join(f.root, ".zshrc");
	await writeFile(profile, "keep-before\n# stepcode\nexport PATH=old\n# stepcode end\nkeep-after\n");
	expect(await ensureStepShellPath(f.input)).toEqual([]);
	const updated = await readFile(profile, "utf8");
	expect(updated).toContain("keep-before\nkeep-after\n");
	expect(updated).not.toContain("PATH=old");
	expect(updated.match(/^# stepcode$/gm)).toHaveLength(1);
});

test.each([
	"# stepcode\nexport IMPORTANT=preserve\nalias custom=keep\n",
	"# stepcode\n# stepcode\nexport IMPORTANT=preserve\n# stepcode end\n# stepcode end\n",
	"# stepcode end\nexport IMPORTANT=preserve\n# stepcode\n",
])("leaves malformed user-edited markers unchanged: %s", async (original) => {
	const f = await fixture();
	const profile = join(f.root, ".zshrc");
	await writeFile(profile, original);
	expect((await ensureStepShellPath(f.input)).join(" ")).toContain("incomplete");
	expect(await readFile(profile, "utf8")).toBe(original);
});

test("honors ZDOTDIR and a custom agent directory", async () => {
	const f = await fixture();
	const zdot = join(f.root, "zsh-config");
	await mkdir(zdot);
	expect(
		await ensureStepShellPath({
			...f.input,
			env: { ...f.env, ZDOTDIR: zdot, STEP_CODING_AGENT_DIR: join(f.root, "agent") },
		}),
	).toEqual([]);
	const profile = await readFile(join(zdot, ".zshrc"), "utf8");
	expect(profile).toContain(join(f.root, "agent", "bin"));
	await expect(readFile(join(f.root, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
});
