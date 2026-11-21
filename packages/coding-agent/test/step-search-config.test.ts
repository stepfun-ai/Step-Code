import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSearchChainMode, SEARCH_PROVIDER_ENV } from "../src/step/search-web-tool.ts";

async function withConfigRoot<T>(content: string | undefined, run: (env: Record<string, string>) => Promise<T> | T) {
	const root = await mkdtemp(join(tmpdir(), "step-search-config-"));
	try {
		// `resolveStepConfigRoot` derives the config directory from the agent
		// directory's parent, so pointing that at a temp path isolates the file.
		const env: Record<string, string | undefined> = { STEP_CODING_AGENT_DIR: join(root, "agent") };
		if (content !== undefined) await writeFile(join(root, "config.toml"), content, "utf8");
		return await run(env as Record<string, string>);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("search backend selection", () => {
	it("defaults to auto when nothing is configured", async () => {
		await withConfigRoot(undefined, (env) => {
			expect(resolveSearchChainMode({ env })).toBe("auto");
		});
	});

	it("reads the provider from config.toml", async () => {
		await withConfigRoot('[search]\nprovider = "firecrawl"\n', (env) => {
			expect(resolveSearchChainMode({ env })).toBe("firecrawl");
		});
	});

	it("prefers the environment over config.toml", async () => {
		await withConfigRoot('[search]\nprovider = "firecrawl"\n', (env) => {
			expect(resolveSearchChainMode({ env: { ...env, [SEARCH_PROVIDER_ENV]: "tavily" } })).toBe("tavily");
		});
	});

	it("prefers an explicit option over both", async () => {
		await withConfigRoot('[search]\nprovider = "firecrawl"\n', (env) => {
			expect(resolveSearchChainMode({ env: { ...env, [SEARCH_PROVIDER_ENV]: "tavily" }, provider: "off" })).toBe(
				"off",
			);
		});
	});

	it("treats an unrecognized provider as auto instead of failing", async () => {
		await withConfigRoot(undefined, (env) => {
			// An older config or a removed provider must not disable search.
			expect(resolveSearchChainMode({ env: { ...env, [SEARCH_PROVIDER_ENV]: "exaa" } })).toBe("auto");
			expect(resolveSearchChainMode({ env: { ...env, [SEARCH_PROVIDER_ENV]: "some-removed-provider" } })).toBe(
				"auto",
			);
		});
	});

	it("still reports a malformed config file, which is not a value problem", async () => {
		await withConfigRoot("this is not toml [[[\n", (env) => {
			// An unreadable file is a real error; it is not the same as an
			// unrecognized value, which degrades to auto.
			expect(() => resolveSearchChainMode({ env })).toThrow(/Invalid Step config TOML/u);
		});
	});
});
