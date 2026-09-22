import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { ProjectTrustDeclinedError, resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

let workspace: string;
let agentDir: string;
let bare: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "project-trust-"));
	agentDir = join(workspace, "agent");
	bare = join(workspace, "bare");
	mkdirSync(bare, { recursive: true });
	writeFileSync(join(bare, "README.md"), "# hi\n", "utf8");
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function context(asked: string[], answer: string | undefined): ProjectTrustContext {
	return {
		cwd: bare,
		mode: "tui",
		hasUI: true,
		ui: {
			select: async (title) => {
				asked.push(title);
				return answer;
			},
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
}

describe("resolveProjectTrusted", () => {
	it("asks about a directory that ships no project config", async () => {
		// The contents themselves are the risk: a file can be written to instruct
		// the model, whether or not the directory also carries a settings.json.
		const asked: string[] = [];
		const trusted = await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			alwaysAsk: true,
			projectTrustContext: context(asked, "Yes, continue"),
		});

		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("Do you trust the contents of this folder?");
		expect(asked[0]).toContain("prompt injection");
		expect(trusted).toBe(true);
	});

	it("remembers the answer instead of asking again", async () => {
		const store = new ProjectTrustStore(agentDir);
		const first: string[] = [];
		await resolveProjectTrusted({
			cwd: bare,
			trustStore: store,
			configDirName: ".stepcode",
			alwaysAsk: true,
			projectTrustContext: context(first, "Yes, continue"),
		});

		const second: string[] = [];
		const trusted = await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			alwaysAsk: true,
			projectTrustContext: context(second, undefined),
		});

		expect(second).toEqual([]);
		expect(trusted).toBe(true);
	});

	it("honours defaultProjectTrust as the opt-out", async () => {
		const asked: string[] = [];
		const trusted = await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			alwaysAsk: true,
			defaultProjectTrust: "always",
			projectTrustContext: context(asked, undefined),
		});

		expect(asked).toEqual([]);
		expect(trusted).toBe(true);
	});

	it("does not trust a directory it cannot ask about", async () => {
		// Headless runs have no one to answer; silently trusting would defeat the
		// gate entirely.
		const asked: string[] = [];
		const trusted = await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			alwaysAsk: true,
			projectTrustContext: { ...context(asked, undefined), hasUI: false },
		});

		expect(asked).toEqual([]);
		expect(trusted).toBe(false);
	});

	it("offers exactly two answers", async () => {
		let offered: readonly string[] = [];
		await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			alwaysAsk: true,
			projectTrustContext: {
				cwd: bare,
				mode: "tui",
				hasUI: true,
				ui: {
					select: async (_title, options) => {
						offered = options;
						return options[0];
					},
					confirm: async () => false,
					input: async () => undefined,
					notify: () => {},
				},
			},
		});

		expect(offered).toEqual(["Yes, continue", "No, quit"]);
	});

	it("quits instead of continuing when the prompt is declined or dismissed", async () => {
		// Escape used to drop the user into an untrusted session, which looked like
		// the prompt had simply been skipped.
		for (const answer of ["No, quit", undefined]) {
			const asked: string[] = [];
			await expect(
				resolveProjectTrusted({
					cwd: bare,
					trustStore: new ProjectTrustStore(agentDir),
					configDirName: ".stepcode",
					alwaysAsk: true,
					projectTrustContext: context(asked, answer),
				}),
			).rejects.toBeInstanceOf(ProjectTrustDeclinedError);
			expect(asked).toHaveLength(1);
		}
	});

	it("does not record a decision when the user declines", async () => {
		const store = new ProjectTrustStore(agentDir);
		await expect(
			resolveProjectTrusted({
				cwd: bare,
				trustStore: store,
				configDirName: ".stepcode",
				alwaysAsk: true,
				projectTrustContext: context([], "No, quit"),
			}),
		).rejects.toBeInstanceOf(ProjectTrustDeclinedError);

		// Nothing saved, so the next launch asks again rather than silently
		// running untrusted forever.
		expect(new ProjectTrustStore(agentDir).get(bare)).toBeNull();
	});
	it("lets a caller that only writes project config bootstrap a fresh directory", async () => {
		// `step package --local` has to be able to create the first settings.json,
		// so without alwaysAsk a directory carrying no project config is trusted.
		const asked: string[] = [];
		const trusted = await resolveProjectTrusted({
			cwd: bare,
			trustStore: new ProjectTrustStore(agentDir),
			configDirName: ".stepcode",
			projectTrustContext: context(asked, undefined),
		});

		expect(asked).toEqual([]);
		expect(trusted).toBe(true);
	});
});
