import { setKeybindings } from "@step-harness/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/ui/view/dialogs/oauth-selector.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("projects provider-owned auth options without provider-specific filtering", () => {
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(
						this: object,
						authType?: "oauth" | "api_key",
					): Array<{ id: string; name: string; authType: string; method?: { name: string; login?: unknown } }>;
				};
			}
		).prototype.getLoginProviderOptions;
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				auth: {
					oauth: { name: "Anthropic (Claude Pro/Max)", login: async () => ({}) },
					apiKey: { name: "Anthropic API key", login: async () => ({}) },
				},
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				auth: { apiKey: { name: "Google Cloud credentials" } },
			},
		];
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => providers,
					getProviderAuthStatus: () => ({ configured: false }),
					isUsingOAuth: () => false,
				},
			},
		};

		const apiKeyOptions = getLoginProviderOptions.call(fakeThis, "api_key");
		expect(apiKeyOptions).toMatchObject([
			{
				id: "anthropic",
				name: "Anthropic",
				authType: "api_key",
				method: { name: "Anthropic API key" },
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				authType: "api_key",
				method: { name: "Google Cloud credentials" },
			},
		]);
		expect(getLoginProviderOptions.call(fakeThis, "oauth")).toMatchObject([
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
		]);
	});

	it("lists stored credentials when product options are absent", async () => {
		const getLogoutProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLogoutProviderOptions(
						this: object,
					): Promise<Array<{ id: string; name: string; authType: string; status?: { source: string } }>>;
				};
			}
		).prototype.getLogoutProviderOptions;
		const fakeThis = {
			session: {
				modelRuntime: {
					listCredentials: async () => [{ providerId: "anthropic", type: "oauth" as const }],
					getProvider: () => ({ name: "Anthropic" }),
				},
			},
		};

		expect(await getLogoutProviderOptions.call(fakeThis)).toMatchObject([
			{
				id: "anthropic",
				name: "Anthropic",
				authType: "oauth",
				status: { source: "stored credential" },
			},
		]);
	});

	it("renders an option without compiled auth status as unconfigured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "google", name: "Google", authType: "api_key", status: undefined }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("unconfigured");
		expect(output).not.toContain("✓ configured");
	});

	it("shows OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "anthropic", name: "Anthropic", authType: "api_key", status: { type: "oauth", source: "OAuth" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "openai", name: "OpenAI", authType: "api_key", status: { type: "api_key", source: "OPENAI_API_KEY" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "local-proxy",
					name: "local-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "key in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "op-proxy",
					name: "op-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "command in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ command in models.json");
	});

	it("delegates navigation and confirmation to the native SelectList", () => {
		const selected: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{ id: "first", name: "First", authType: "oauth" },
				{ id: "second", name: "Second", authType: "oauth" },
			],
			(providerId) => selected.push(providerId),
			() => {},
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(selected).toEqual(["second"]);
	});

	it("keeps Step provider navigation bounded while native selectors wrap", () => {
		const stepSelected: string[] = [];
		const stepSelector = new OAuthSelectorComponent(
			"login",
			[
				{ id: "first", name: "First", authType: "oauth" },
				{ id: "second", name: "Second", authType: "oauth" },
			],
			(providerId) => stepSelected.push(providerId),
			() => {},
			undefined,
			{ presentation: "step" },
		);

		stepSelector.handleInput("\x1b[A");
		stepSelector.handleInput("\r");
		expect(stepSelected).toEqual(["first"]);
		expect(stripAnsi(stepSelector.render(100).join("\n"))).toContain("╭");
		expect(stripAnsi(stepSelector.render(100).join("\n"))).toContain("Select provider to configure:");
	});

	it("updates the native list through fuzzy filtering", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "google", name: "Google", authType: "oauth" },
			],
			() => {},
			() => {},
		);

		selector.handleInput("goo");
		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Google");
		expect(output).not.toContain("Anthropic");
	});
});
