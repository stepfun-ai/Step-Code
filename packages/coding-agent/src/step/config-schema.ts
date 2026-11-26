/**
 * Editor-facing contract for the files StepCode reads from the config root:
 * `config.toml` and `models.json`.
 *
 * Both schemas are derived from the same TypeBox definitions the runtime loads
 * through, so a key cannot exist in one and not the other. They are generated
 * into `schema/*.json` and shipped beside the binary; nothing is fetched from
 * the network, so an editor always validates against the version of the binary
 * that wrote the file.
 *
 * `additionalProperties: false` makes the schema stricter than the runtime on
 * purpose: the loaders keep an unknown key and ignore it, while an editor flags
 * it. That difference is the feature — `step config check` reports the same key
 * so a typo is visible without an editor, and a launch never fails because of it.
 */

import { type Static, Type } from "typebox";
import { ModelsConfigSchema } from "../core/model-config.ts";
import { RetrySettingsSchema, SettingsSchema } from "../core/settings-schema.ts";
import { ThemeJsonSchema } from "../theme/theme-schema.ts";
import type { SearchChainMode } from "./search/types.ts";
import { SEARCH_CHAIN_MODES } from "./search/types.ts";
import {
	SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS,
	SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
	SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS,
	SUBAGENT_MAX_CONCURRENCY_DEFAULT,
} from "./subagent-limits.ts";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const optionalDescription = (description: string) => Type.Optional(Type.String({ description }));

const PermissionPresetSchema = Type.Union(
	[
		Type.Literal("ask"),
		Type.Literal("approve-for-me"),
		Type.Literal("full-access"),
		// Spellings `normalizeStepPermissionPresetId` maps onto the three tiers.
		Type.Literal("confirm"),
		Type.Literal("approve"),
		Type.Literal("approveforme"),
		Type.Literal("bypass"),
		Type.Literal("auto"),
		Type.Literal("autopilot"),
		Type.Literal("bypasspermissions"),
		Type.Literal("fullaccess"),
		Type.Literal("full"),
		Type.Literal("yolo"),
		Type.Literal("never-ask"),
		Type.Literal("read-only"),
		Type.Literal("readonly"),
		Type.Literal("strict"),
		Type.Literal("plan"),
	],
	{
		description:
			"Initial approval tier: `ask`, `approve-for-me` (default), or `full-access`. Legacy spellings are accepted and mapped: `confirm`/`auto`/`bypass`/`strict`/`plan`/`read-only` mean `ask`, `approve` means `approve-for-me`, `full`/`fullaccess`/`yolo`/`never-ask` mean `full-access`. Matching ignores case and surrounding spaces. Full Access also needs `fullAccessAcknowledged` from its one-time prompt.",
	},
);

const ApprovalModeSchema = Type.Union(
	[
		Type.Literal("confirm"),
		Type.Literal("auto"),
		// Spellings `normalizeStepPermissionMode` maps onto the two modes.
		Type.Literal("ask"),
		Type.Literal("default"),
		Type.Literal("acceptedits"),
		Type.Literal("strict"),
		Type.Literal("read-only"),
		Type.Literal("readonly"),
		Type.Literal("plan"),
		Type.Literal("bypass"),
		Type.Literal("bypasspermissions"),
	],
	{
		description:
			"Low-level override of the tier's default approval mode: `confirm` or `auto`. Legacy spellings `ask`/`default`/`acceptedits`/`strict`/`read-only`/`plan` mean `confirm`; `bypass`/`bypasspermissions` mean `auto`.",
	},
);

const NonInteractiveApprovalSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
	description:
		"Approval fallback when no interactive UI can answer a confirmation: `allow` or `deny` (default). Matching ignores case.",
});

/**
 * The approval table is accepted at `[approval]`, `[tools.approval]`, and as
 * flat keys. All spellings are documented so an editor accepts a file written
 * by any of them, and the descriptions say which one to prefer.
 */
const ApprovalTableSchema = Type.Object(
	{
		preset: Type.Optional(PermissionPresetSchema),
		mode: Type.Optional(ApprovalModeSchema),
		nonInteractive: Type.Optional(NonInteractiveApprovalSchema),
		noninteractive: Type.Optional(
			Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
				description: "Accepted for older files; prefer `nonInteractive`.",
			}),
		),
		autoResume: Type.Optional(
			Type.Boolean({ description: "Resume after a bounded model error without asking again." }),
		),
		autopilot: Type.Optional(Type.Boolean({ description: "Accepted for older files; prefer `autoResume`." })),
		fullAccessAcknowledged: Type.Optional(
			Type.Boolean({
				description:
					'Set by "Yes, and do not ask again" when Full Access is selected; cleared when the tier is not Full Access.',
			}),
		),
	},
	{ additionalProperties: false, description: "Approval tier overrides." },
);

const SubagentTableSchema = Type.Object(
	{
		background: Type.Optional(
			Type.Boolean({ description: "Run `run_in_background` subagent calls in a background lane (default true)." }),
		),
		background_timeout_seconds: Type.Optional(
			Type.Integer({
				minimum: SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS,
				maximum: SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
				description: `Per-turn wall-clock limit of a background lane in seconds (default ${SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS}, ${SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS}-${SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS}). A call's own timeout takes precedence.`,
			}),
		),
		max_concurrency: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: `Child processes a parallel batch runs at once (default ${SUBAGENT_MAX_CONCURRENCY_DEFAULT}, no upper bound).`,
			}),
		),
	},
	{ additionalProperties: false, description: "Subagent concurrency and background lanes." },
);

const SearchTableSchema = Type.Object(
	{
		provider: Type.Optional(
			Type.Union(
				SEARCH_CHAIN_MODES.map((mode) => Type.Literal(mode)),
				{
					description:
						"Web search backend. `auto` (default) walks the chain; a backend id pins one; `off` keeps the tool but refuses calls. The runtime treats an unrecognized value as `auto`, so a misspelling silently disables the pin instead of failing; `step config check` flags it.",
				},
			),
		),
	},
	{ additionalProperties: false, description: "Web search backend selection." },
);

/**
 * The `retry` table with the one legacy key the loader rewrites.
 *
 * Derived from the runtime table so a new field there cannot be missed here.
 */
const LegacyRetryTableSchema = Type.Object(
	{
		...RetrySettingsSchema.properties,
		maxDelayMs: Type.Optional(
			Type.Number({
				minimum: 0,
				description: "Older spelling of `provider.maxRetryDelayMs`; migrated on load.",
			}),
		),
	},
	{ additionalProperties: false, description: "Retry and backoff behavior." },
);

const TelemetryTableSchema = Type.Object(
	{
		enabled: Type.Optional(
			Type.Boolean({ description: "Send product telemetry. An explicit `false` is honored over any default." }),
		),
		spool: Type.Optional(Type.Boolean({ description: "Buffer events on disk when the endpoint is unreachable." })),
		endpoint: Type.Optional(Type.String({ description: "Telemetry endpoint override." })),
	},
	{ additionalProperties: false, description: "Product telemetry." },
);

const McpOauthSchema = Type.Object(
	{
		client_id: Type.Optional(Type.String({ description: "Static OAuth client id." })),
		client_secret: Type.Optional(Type.String({ description: "Static OAuth client secret." })),
		scopes: Type.Optional(Type.Array(Type.String(), { description: "Requested OAuth scopes." })),
		callback_port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535, description: "Local callback port." })),
	},
	{ additionalProperties: false, description: "OAuth settings for an HTTP MCP server." },
);

const McpServerSchema = Type.Object(
	{
		command: Type.Optional(
			Type.String({ description: "Executable for a stdio server; mutually exclusive with `url`." }),
		),
		args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for `command`." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for `command`." })),
		url: Type.Optional(Type.String({ description: "Endpoint for an HTTP or SSE server." })),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "Extra environment for `command`." }),
		),
		bearer_token_env_var: Type.Optional(
			Type.String({ description: "Environment variable holding a bearer token for `url`." }),
		),
		http_headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "Static headers sent with every HTTP request." }),
		),
		env_http_headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Header names whose value is read from the named environment variable.",
			}),
		),
		enabled: Type.Optional(Type.Boolean({ description: "Set `false` to keep the declaration but skip connecting." })),
		tool_timeout_sec: Type.Optional(Type.Number({ minimum: 0, description: "Per-call timeout in seconds." })),
		startup_timeout_sec: Type.Optional(Type.Number({ minimum: 0, description: "Connection timeout in seconds." })),
		enabled_tools: Type.Optional(Type.Array(Type.String(), { description: "Publish only these tools." })),
		disabled_tools: Type.Optional(Type.Array(Type.String(), { description: "Never publish these tools." })),
		oauth: Type.Optional(McpOauthSchema),
	},
	{ additionalProperties: false, description: "One MCP server declaration." },
);

/**
 * Keys the product writes at the document root. Kept flat because that is the
 * shape the settings storage merges; the nested spellings above are aliases the
 * loaders still honor.
 */
const StepProductProperties = {
	permissionPreset: Type.Optional(PermissionPresetSchema),
	permissionMode: Type.Optional(PermissionPresetSchema),
	approvalMode: Type.Optional(ApprovalModeSchema),
	nonInteractiveApproval: Type.Optional(NonInteractiveApprovalSchema),
	noninteractiveApproval: Type.Optional(
		Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
			description: "Accepted for older files; prefer `nonInteractiveApproval`.",
		}),
	),
	autoResume: Type.Optional(Type.Boolean({ description: "Resume after a bounded model error without asking again." })),
	autopilot: Type.Optional(Type.Boolean({ description: "Accepted for older files; prefer `autoResume`." })),
	fullAccessAcknowledged: Type.Optional(Type.Boolean({ description: "Recorded Full Access risk acknowledgment." })),
	feedbackEnabled: Type.Optional(Type.Boolean({ description: "Allow the feedback submission flow (default true)." })),
	subagentBackground: Type.Optional(Type.Boolean({ description: "Flat form of `[subagent] background`." })),
	subagentBackgroundTimeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS,
			maximum: SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
			description: "Flat form of `[subagent] background_timeout_seconds`.",
		}),
	),
	subagentMaxConcurrency: Type.Optional(
		Type.Integer({ minimum: 1, description: "Flat form of `[subagent] max_concurrency`." }),
	),
	approval: Type.Optional(ApprovalTableSchema),
	tools: Type.Optional(
		Type.Object(
			{ approval: Type.Optional(ApprovalTableSchema) },
			{ additionalProperties: false, description: "Tool policy tables." },
		),
	),
	feedback: Type.Optional(
		Type.Object(
			{ enabled: Type.Optional(Type.Boolean({ description: "Allow the feedback submission flow." })) },
			{ additionalProperties: false, description: "Feedback submission." },
		),
	),
	subagent: Type.Optional(SubagentTableSchema),
	// Rewritten by `SettingsManager.migrateSettings` before any read. Listed here
	// so the editor and `config check`, which migrates first, agree about a file
	// that still uses them.
	queueMode: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
			description: "Older spelling of `steeringMode`; migrated on load.",
		}),
	),
	websockets: Type.Optional(
		Type.Boolean({ description: "Older spelling of `transport`; migrated on load (true -> websocket)." }),
	),
	retry: Type.Optional(LegacyRetryTableSchema),
	search: Type.Optional(SearchTableSchema),
	telemetry: Type.Optional(TelemetryTableSchema),
	mcp_servers: Type.Optional(
		Type.Record(Type.String(), McpServerSchema, { description: "MCP servers keyed by the name shown in `/mcp`." }),
	),
	// Written by the first-launch MCP import prompt so it is offered only once.
	// Listed for that reason: a file the product writes must validate against the
	// schema it ships, or the editor reports a false error.
	mcp_import: Type.Optional(
		Type.Object(
			{
				reviewed: Type.Optional(
					Type.Array(Type.String(), { description: "Import sources already offered, by source id." }),
				),
			},
			{ additionalProperties: false, description: "Record of MCP import sources already reviewed." },
		),
	),
};

/** The whole `config.toml` document: runtime settings plus product-owned keys. */
export const ConfigTomlSchema = Type.Object(
	{ ...SettingsSchema.properties, ...StepProductProperties },
	{
		additionalProperties: false,
		description:
			"StepCode `config.toml`. The global file is `~/.stepcode/config.toml`; a trusted project may add `.stepcode/config.toml`, whose values win per key.",
	},
);

/** The whole `models.json` document, including the editor reference field. */
export const ModelsJsonSchema = Type.Object(
	{
		$schema: optionalDescription(
			'Editor reference for this file, for example "./models.schema.json" beside the file.',
		),
		...ModelsConfigSchema.properties,
	},
	{
		additionalProperties: false,
		description:
			"StepCode `models.json`: provider endpoints, credentials and model definitions. JSON with `//` comments is accepted. The global file is `~/.stepcode/models.json`.",
	},
);

type SchemaNode = {
	type?: string;
	properties?: Record<string, SchemaNode>;
	patternProperties?: Record<string, SchemaNode>;
	additionalProperties?: boolean | SchemaNode;
	items?: SchemaNode;
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
	allOf?: SchemaNode[];
};

/**
 * The same document with every object closed to unknown keys.
 *
 * `ModelsConfigSchema` is the loader's validator, so it must keep accepting an
 * unknown field: a newer Step may add one and an older binary still has to load
 * the file. The editor has the opposite job — an unknown field in `models.json`
 * is never read, so it should be flagged. Rendering a closed copy from the same
 * tree keeps the two from drifting while letting them differ on purpose.
 *
 * A record (`patternProperties`) stays open: its keys are data, not field names.
 */
function closeObjects(node: SchemaNode): SchemaNode {
	const closed: SchemaNode = { ...node };
	if (closed.properties) {
		closed.properties = Object.fromEntries(
			Object.entries(closed.properties).map(([key, child]) => [key, closeObjects(child)]),
		);
	}
	if (closed.patternProperties) {
		closed.patternProperties = Object.fromEntries(
			Object.entries(closed.patternProperties).map(([pattern, child]) => [pattern, closeObjects(child)]),
		);
	}
	if (closed.items) closed.items = closeObjects(closed.items);
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const members = closed[key];
		if (members) closed[key] = members.map(closeObjects);
	}
	if (typeof closed.additionalProperties === "object") {
		closed.additionalProperties = closeObjects(closed.additionalProperties);
	}
	// Only an object that names its fields is a closed object; leaving a record
	// open is what keeps `samplingParams` usable.
	if (closed.type === "object" && closed.properties && closed.additionalProperties === undefined) {
		closed.additionalProperties = false;
	}
	return closed;
}

/** `models.json` as the editor and `step config check` should see it. */
const StrictModelsJsonSchema = closeObjects(ModelsJsonSchema as unknown as SchemaNode) as object;

export type ConfigTomlDocument = Static<typeof ConfigTomlSchema>;
export type ModelsJsonDocument = Static<typeof ModelsJsonSchema>;
export type StepProductKey = keyof typeof StepProductProperties;
export type SearchProviderId = SearchChainMode;

/** Render one schema as the JSON document written to `schema/<name>.schema.json`. */
export function renderSchemaJson(schema: object, title: string): string {
	return `${JSON.stringify({ $schema: JSON_SCHEMA_DIALECT, title, ...schema }, null, "\t")}\n`;
}

export const CONFIG_SCHEMA_FILE_NAME = "config.schema.json";
export const MODELS_SCHEMA_FILE_NAME = "models.schema.json";
export const THEME_SCHEMA_FILE_NAME = "theme-schema.json";

export const CONFIG_SCHEMA_TITLE = "StepCode config.toml";
export const MODELS_SCHEMA_TITLE = "StepCode models.json";
export const THEME_SCHEMA_TITLE = "StepCode theme";

export function renderConfigSchema(): string {
	return renderSchemaJson(ConfigTomlSchema, CONFIG_SCHEMA_TITLE);
}

export function renderModelsSchema(): string {
	return renderSchemaJson(ModelsJsonSchema, MODELS_SCHEMA_TITLE);
}

/** The permissive tree, so a test can prove the strict copy differs only there. */
export const PermissiveModelsJsonSchema = ModelsJsonSchema;

/** The closed tree. */
export const ClosedModelsJsonSchema = StrictModelsJsonSchema;

/** `models.json` with unknown fields closed, for editors and `config check`. */
export function renderStrictModelsSchema(): string {
	return renderSchemaJson(StrictModelsJsonSchema, MODELS_SCHEMA_TITLE);
}

/** The theme file shape, rendered from the schema the loader compiles. */
export function renderThemeSchema(): string {
	return renderSchemaJson(ThemeJsonSchema, THEME_SCHEMA_TITLE);
}
