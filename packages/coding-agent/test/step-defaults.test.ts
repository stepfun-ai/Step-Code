import { describe, expect, test } from "vitest";
import {
	getStepDefaultModel,
	getStepDefaultProvider,
	getStepDefaultTheme,
	isStepServicesDisabled,
	STEP_DEFAULT_MODEL,
	STEP_DEFAULT_PROVIDER,
	withStepDefaults,
} from "../src/step/defaults.ts";

describe("Step entrypoint defaults", () => {
	test("uses one blue theme unless the environment overrides it", () => {
		expect(getStepDefaultTheme({})).toBe("step-blue");
		expect(getStepDefaultTheme({ STEPCODE_DEFAULT_THEME: "custom-light/custom-dark" })).toBe(
			"custom-light/custom-dark",
		);
	});

	test("adds the Step provider and model for a bare invocation", () => {
		expect(withStepDefaults([], {})).toEqual(["--provider", STEP_DEFAULT_PROVIDER, "--model", STEP_DEFAULT_MODEL]);
	});

	test("preserves explicit provider and model flags", () => {
		expect(withStepDefaults(["--provider", "openai", "--model", "gpt-4o", "hello"], {})).toEqual([
			"--provider",
			"openai",
			"--model",
			"gpt-4o",
			"hello",
		]);
	});

	test("lets provider-qualified model ids use pi's native inference", () => {
		expect(withStepDefaults(["--model", "openai/gpt-4o"], {})).toEqual(["--model", "openai/gpt-4o"]);
		expect(withStepDefaults(["--model=openai/gpt-4o"], {})).toEqual(["--model=openai/gpt-4o"]);
	});

	test("does not override a provider's own model scope", () => {
		expect(withStepDefaults(["--provider", "openai"], {})).toEqual(["--provider", "openai"]);
		expect(withStepDefaults(["--models", "step/*"], {})).toEqual(["--provider", "step", "--models", "step/*"]);
	});

	test("preserves the persisted model for session restore commands", () => {
		expect(withStepDefaults(["--continue"], {})).toEqual(["--continue"]);
		expect(withStepDefaults(["--resume"], {})).toEqual(["--resume"]);
		expect(withStepDefaults(["--session", "session.jsonl"], {})).toEqual(["--session", "session.jsonl"]);
		expect(withStepDefaults(["--fork", "session.jsonl"], {})).toEqual(["--fork", "session.jsonl"]);
	});

	test("allows an explicit model to override a restored session", () => {
		expect(withStepDefaults(["--continue", "--model", "step-3.5-flash"], {})).toEqual([
			"--provider",
			"step",
			"--continue",
			"--model",
			"step-3.5-flash",
		]);
	});

	test("honors Step environment overrides and leaves package commands untouched", () => {
		const env = { STEP_PROVIDER: "step", STEP_MODEL: "step-router-v1" };
		expect(withStepDefaults(["--help"], env)).toEqual(["--provider", "step", "--help", "--model", "step-router-v1"]);
		expect(withStepDefaults(["config"], env)).toEqual(["config"]);
		expect(withStepDefaults(["auth", "check"], env)).toEqual(["auth", "check", "--provider", "step"]);
		expect(withStepDefaults(["auth", "check", "--model", "openai/gpt-4o"], env)).toEqual([
			"auth",
			"check",
			"--model",
			"openai/gpt-4o",
		]);
	});

	test("keeps bare auth help on the command surface", () => {
		expect(withStepDefaults(["auth"], {})).toEqual(["auth"]);
		expect(withStepDefaults(["auth", "help"], {})).toEqual(["auth", "help"]);
		expect(withStepDefaults(["auth", "--help"], {})).toEqual(["auth", "--help"]);
	});

	test("uses product defaults consistently when direct overrides are absent", () => {
		const env = {
			STEPCODE_DEFAULT_PROVIDER: "step-host",
			STEPCODE_DEFAULT_MODEL: "step-host-model",
		};
		expect(getStepDefaultProvider(env)).toBe("step-host");
		expect(getStepDefaultModel(env)).toBe("step-host-model");
		expect(withStepDefaults([], env)).toEqual(["--provider", "step-host", "--model", "step-host-model"]);

		expect(
			withStepDefaults([], {
				...env,
				STEP_PROVIDER: "step",
				STEP_MODEL: "step-router-v1",
			}),
		).toEqual(["--provider", "step", "--model", "step-router-v1"]);
		expect(getStepDefaultProvider({ STEP_MODEL_PROVIDER: "stepcode-anthropic" })).toBe("stepcode-anthropic");
		expect(withStepDefaults([], { STEP_MODEL_PROVIDER: "stepcode-anthropic", STEP_MODEL: "water18-new" })).toEqual([
			"--provider",
			"stepcode-anthropic",
			"--model",
			"water18-new",
		]);
	});

	test("uses persisted Pi defaults before the implicit Step fallback", () => {
		expect(
			withStepDefaults(
				[],
				{},
				{
					defaultProvider: "openai",
					defaultModel: "gpt-4o",
				},
			),
		).toEqual(["--provider", "openai", "--model", "gpt-4o"]);

		// The launcher seeds these legacy names with Step's own fallback. They
		// must not hide a migrated/persisted selection.
		expect(
			withStepDefaults(
				[],
				{
					STEPCODE_DEFAULT_PROVIDER: STEP_DEFAULT_PROVIDER,
					STEPCODE_DEFAULT_MODEL: STEP_DEFAULT_MODEL,
				},
				{ provider: "anthropic", model: "claude-sonnet" },
			),
		).toEqual(["--provider", "anthropic", "--model", "claude-sonnet"]);
	});

	test("can defer implicit selection to project-aware runtime settings", () => {
		expect(
			withStepDefaults(
				["--print", "hello"],
				{ STEPCODE_DEFAULT_PROVIDER: STEP_DEFAULT_PROVIDER, STEPCODE_DEFAULT_MODEL: STEP_DEFAULT_MODEL },
				{ provider: "models-proxy", model: "global-wire" },
				{ deferSettingsSelection: true },
			),
		).toEqual(["--print", "hello"]);
		expect(
			withStepDefaults(
				["--print", "hello"],
				{ STEP_PROVIDER: "custom", STEPCODE_DEFAULT_PROVIDER: "custom", STEP_MODEL: "wire" },
				undefined,
				{ deferSettingsSelection: true },
			),
		).toEqual(["--provider", "custom", "--print", "hello", "--model", "wire"]);
	});

	test("keeps explicit CLI and environment selections ahead of persisted defaults", () => {
		const persisted = { defaultProvider: "openai", defaultModel: "gpt-4o" };
		expect(withStepDefaults(["--provider", "ollama", "--model", "llama3"], {}, persisted)).toEqual([
			"--provider",
			"ollama",
			"--model",
			"llama3",
		]);
		expect(withStepDefaults([], { STEP_PROVIDER: "anthropic", STEP_MODEL: "claude-3-7" }, persisted)).toEqual([
			"--provider",
			"anthropic",
			"--model",
			"claude-3-7",
		]);
		expect(
			withStepDefaults(
				[],
				{ STEPCODE_DEFAULT_PROVIDER: "anthropic", STEPCODE_DEFAULT_MODEL: "claude-3-7" },
				persisted,
			),
		).toEqual(["--provider", "anthropic", "--model", "claude-3-7"]);
	});

	test("routes bare Step model ids to the Step provider after a legacy provider migration", () => {
		const persisted = { provider: "models-proxy", model: "claude-opus-5" };
		expect(withStepDefaults(["--model", "step-3.7-flash"], {}, persisted)).toEqual([
			"--provider",
			"step",
			"--model",
			"step-3.7-flash",
		]);
		expect(withStepDefaults(["--model", "step-3.7-flash:high"], {}, persisted)).toEqual([
			"--provider",
			"step",
			"--model",
			"step-3.7-flash:high",
		]);
	});

	test("does not override an explicit models-proxy provider", () => {
		const persisted = { provider: "models-proxy", model: "step-3.7-flash" };
		expect(withStepDefaults(["--provider", "models-proxy", "--model", "step-3.7-flash"], {}, persisted)).toEqual([
			"--provider",
			"models-proxy",
			"--model",
			"step-3.7-flash",
		]);
		expect(withStepDefaults(["--model", "step-3.7-flash"], { STEP_PROVIDER: "models-proxy" }, persisted)).toEqual([
			"--provider",
			"models-proxy",
			"--model",
			"step-3.7-flash",
		]);
	});

	test("routes a persisted Step model to Step when its migrated provider is stale", () => {
		expect(withStepDefaults([], {}, { provider: "models-proxy", model: "step-3.7-flash" })).toEqual([
			"--provider",
			"step",
			"--model",
			"step-3.7-flash",
		]);
		expect(
			withStepDefaults(
				[],
				{ STEPCODE_DEFAULT_PROVIDER: STEP_DEFAULT_PROVIDER, STEPCODE_DEFAULT_MODEL: STEP_DEFAULT_MODEL },
				{ provider: "models-proxy-openai", model: "step-3.7-flash" },
				{ deferSettingsSelection: true },
			),
		).toEqual(["--provider", "step", "--model", "step-3.7-flash"]);
		expect(
			withStepDefaults(
				["--continue"],
				{ STEPCODE_DEFAULT_PROVIDER: STEP_DEFAULT_PROVIDER, STEPCODE_DEFAULT_MODEL: STEP_DEFAULT_MODEL },
				{ provider: "models-proxy-openai", model: "step-3.7-flash" },
				{ deferSettingsSelection: true },
			),
		).toEqual(["--continue"]);
	});

	test("does not carry a persisted model across an explicitly selected provider", () => {
		expect(withStepDefaults([], { STEP_PROVIDER: "ollama" }, { provider: "openai", model: "gpt-4o" })).toEqual([
			"--provider",
			"ollama",
		]);
	});

	test("preserves session restore semantics when persisted defaults are available", () => {
		const persisted = { defaultProvider: "openai", defaultModel: "gpt-4o" };
		expect(withStepDefaults(["--continue"], {}, persisted)).toEqual(["--continue"]);
		expect(withStepDefaults(["--resume"], {}, persisted)).toEqual(["--resume"]);
	});

	test("inserts defaults before the end-of-options delimiter", () => {
		expect(withStepDefaults(["--", "- keep this as text"], {})).toEqual([
			"--provider",
			STEP_DEFAULT_PROVIDER,
			"--model",
			STEP_DEFAULT_MODEL,
			"--",
			"- keep this as text",
		]);
	});

	test("uses conventional false values for the service switch", () => {
		expect(isStepServicesDisabled({ STEPCODE_DISABLE_PI_SERVICES: "1" })).toBe(true);
		expect(isStepServicesDisabled({ STEPCODE_DISABLE_PI_SERVICES: "yes" })).toBe(true);
		expect(isStepServicesDisabled({ STEPCODE_DISABLE_PI_SERVICES: "0" })).toBe(false);
		expect(isStepServicesDisabled({ STEPCODE_DISABLE_PI_SERVICES: "off" })).toBe(false);
		expect(isStepServicesDisabled({})).toBe(false);
	});
});
