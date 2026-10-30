/**
 * New declarations use form/JSON import. Existing declarations use explicit,
 * revision-checked patches: protected values stay on the Host and omitted fields
 * mean keep. Form/JSON transitions preserve tool restrictions and every operation.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend } from "../../lib/api";
import { cx } from "../../lib/format";
import { showError } from "../../state/session";
import type { SettingsEditor } from "../../state/store";
import type { McpServerConfig, SettingsMcpServer } from "../../state/types";
import { Button, Icon, SegmentedControl } from "../../ui";
import { SettingsSelect } from "./parts";

type Transport = "stdio" | "http";

/** Declaration fields with no form control, kept as loaded. */
type HiddenFields = Pick<
	McpServerConfig,
	"enabled_tools" | "disabled_tools" | "env_http_headers" | "oauth" | "shared" | "enabled"
>;

export interface FormState {
	readonly name: string;
	readonly transport: Transport;
	readonly command: string;
	readonly args: string;
	readonly cwd: string;
	readonly env: string;
	readonly url: string;
	readonly headers: string;
	readonly bearer: string;
	readonly startupTimeout: string;
	readonly toolTimeout: string;
	readonly hidden: HiddenFields;
}

const EMPTY_FORM: FormState = {
	name: "",
	transport: "stdio",
	command: "",
	args: "",
	cwd: "",
	env: "",
	url: "",
	headers: "",
	bearer: "",
	startupTimeout: "",
	toolTimeout: "",
	hidden: {},
};

const IMPORT_SAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Split a command line into arguments; double or single quotes keep spaces together. */
export function splitArgs(text: string): string[] {
	const args: string[] = [];
	for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) args.push(match[1] ?? match[2] ?? match[3] ?? "");
	return args;
}

function joinArgs(args: readonly string[]): string {
	return args.map((arg) => (/[\s"']/u.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg)).join(" ");
}

/** `KEY=VALUE` (env) or `Key: Value` (headers) lines into a record; blank lines are skipped. */
function parsePairs(text: string, separator: "=" | ":"): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf(separator);
		if (index <= 0) continue;
		result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function formatPairs(record: Readonly<Record<string, string>> | undefined, separator: "=" | ": "): string {
	return Object.entries(record ?? {})
		.map(([key, value]) => `${key}${separator}${value}`)
		.join("\n");
}

function numberOrUndefined(text: string): number | undefined {
	const value = Number(text.trim());
	return text.trim() && Number.isFinite(value) ? value : undefined;
}

export function formFromConfig(name: string, config: McpServerConfig | undefined): FormState {
	if (!config) return { ...EMPTY_FORM, name };
	return {
		name,
		transport: config.url ? "http" : "stdio",
		command: config.command ?? "",
		args: joinArgs(config.args ?? []),
		cwd: config.cwd ?? "",
		env: formatPairs(config.env, "="),
		url: config.url ?? "",
		headers: formatPairs(config.http_headers, ": "),
		bearer: config.bearer_token_env_var ?? "",
		startupTimeout: config.startup_timeout_sec?.toString() ?? "",
		toolTimeout: config.tool_timeout_sec?.toString() ?? "",
		hidden: {
			enabled_tools: config.enabled_tools,
			disabled_tools: config.disabled_tools,
			env_http_headers: config.env_http_headers,
			oauth: config.oauth,
			shared: config.shared,
			enabled: config.enabled,
		},
	};
}

export function configFromForm(form: FormState): McpServerConfig {
	const timeouts = {
		startup_timeout_sec: numberOrUndefined(form.startupTimeout),
		tool_timeout_sec: numberOrUndefined(form.toolTimeout),
		enabled_tools: form.hidden.enabled_tools,
		disabled_tools: form.hidden.disabled_tools,
		shared: form.hidden.shared,
		enabled: form.hidden.enabled,
	};
	if (form.transport === "http") {
		return {
			url: form.url.trim(),
			http_headers: parsePairs(form.headers, ":"),
			bearer_token_env_var: form.bearer.trim() || undefined,
			env_http_headers: form.hidden.env_http_headers,
			oauth: form.hidden.oauth,
			...timeouts,
		};
	}
	return {
		command: form.command.trim(),
		args: splitArgs(form.args),
		cwd: form.cwd.trim() || undefined,
		env: parsePairs(form.env, "="),
		...timeouts,
	};
}

/**
 * Drop undefined fields and empty lists so the JSON tab shows only what is set.
 * An empty `enabled_tools` stays: it means "no tool reachable", not "unset".
 */
function compact(config: McpServerConfig): McpServerConfig {
	return Object.fromEntries(
		Object.entries(config).filter(
			([key, value]) =>
				value !== undefined && (key === "enabled_tools" || !(Array.isArray(value) && value.length === 0)),
		),
	) as McpServerConfig;
}

/**
 * Accept `{ "mcpServers": { name: config } }`, `{ name: config }` or a bare
 * config (named by the form). Compatible `headers` becomes `http_headers`;
 * the host drops fields it does not know, such as `type`.
 */
export function serversFromJson(text: string, fallbackName: string): Array<[string, Record<string, unknown>]> {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error("JSON must be an object");
	const table = isRecord(parsed.mcpServers)
		? parsed.mcpServers
		: isRecord(parsed.mcp_servers)
			? parsed.mcp_servers
			: parsed;
	const entries: Array<[string, unknown]> =
		"command" in table || "url" in table ? [[fallbackName, table]] : Object.entries(table);
	if (entries.length === 0) throw new Error("No servers found");
	return entries.map(([name, value]) => {
		if (!isRecord(value)) throw new Error(`'${name}' must be an object`);
		const { headers, type: _type, ...rest } = value;
		return [name, rest.http_headers === undefined && isRecord(headers) ? { ...rest, http_headers: headers } : rest];
	});
}

const PATCH_FIELDS = [
	"command",
	"args",
	"cwd",
	"env",
	"url",
	"http_headers",
	"oauth",
	"bearer_token_env_var",
	"env_http_headers",
	"enabled_tools",
	"disabled_tools",
	"startup_timeout_sec",
	"tool_timeout_sec",
	"enabled",
	"shared",
] as const satisfies readonly (keyof McpServerConfig)[];
type PatchField = (typeof PATCH_FIELDS)[number];
type PatchOperation = "keep" | "set" | "remove";
interface FieldDraft {
	readonly operation: PatchOperation;
	readonly text: string;
}
export interface McpPatchDraft {
	readonly revision: string;
	readonly transport: Transport;
	readonly fields: Readonly<Record<PatchField, FieldDraft>>;
}
export interface McpEditPatch {
	readonly revision: string;
	readonly fields: Partial<
		Record<PatchField, { operation: "keep" | "remove" } | { operation: "set"; value: unknown }>
	>;
}

/** Protected values are never loaded, even if a stale host supplied them. */
export function initialMcpPatchDraft(existing: SettingsMcpServer): McpPatchDraft {
	const alwaysHidden: readonly PatchField[] = ["command", "args", "cwd", "env", "url", "http_headers", "oauth"];
	const fields = Object.fromEntries(
		PATCH_FIELDS.map((field) => {
			const hidden = alwaysHidden.includes(field) || existing.protectedFields?.includes(field);
			const value = hidden ? undefined : existing.config?.[field];
			return [field, { operation: "keep", text: value === undefined ? "" : JSON.stringify(value, null, 2) }];
		}),
	) as Record<PatchField, FieldDraft>;
	return { revision: existing.revision ?? "", transport: existing.transport, fields };
}

export function mcpPatchFromDraft(draft: McpPatchDraft): McpEditPatch {
	if (!/^[a-f0-9]{64}$/u.test(draft.revision)) throw new Error("Invalid revision");
	const fields: McpEditPatch["fields"] = {};
	for (const field of PATCH_FIELDS) {
		const change = draft.fields[field];
		fields[field] =
			change.operation === "set"
				? { operation: "set", value: JSON.parse(change.text) as unknown }
				: { operation: change.operation };
	}
	return { revision: draft.revision, fields };
}

/** A missing JSON field means keep, never deletion or a reset of a restriction. */
export function mcpPatchDraftFromJson(text: string, existing: SettingsMcpServer): McpPatchDraft {
	const patch: unknown = JSON.parse(text);
	if (
		!isRecord(patch) ||
		patch.revision !== existing.revision ||
		Object.keys(patch).some((key) => key !== "revision" && key !== "fields") ||
		!isRecord(patch.fields)
	) {
		throw new Error("Invalid patch");
	}
	let draft = initialMcpPatchDraft(existing);
	const fields = { ...draft.fields };
	for (const [key, raw] of Object.entries(patch.fields)) {
		if (!PATCH_FIELDS.some((field) => field === key) || !isRecord(raw)) throw new Error("Invalid field");
		const field = key as PatchField;
		if (raw.operation === "set" && Object.keys(raw).length === 2 && Object.hasOwn(raw, "value")) {
			fields[field] = { operation: "set", text: JSON.stringify(raw.value, null, 2) };
		} else if ((raw.operation === "keep" || raw.operation === "remove") && Object.keys(raw).length === 1) {
			fields[field] = { operation: raw.operation, text: fields[field].text };
		} else throw new Error("Invalid operation");
	}
	const transport =
		fields.url.operation === "set" ? "http" : fields.command.operation === "set" ? "stdio" : existing.transport;
	draft = { ...draft, fields, transport };
	mcpPatchFromDraft(draft);
	return draft;
}

/** A transport change explicitly removes incompatible fields, but never tool restrictions. */
export function changeMcpPatchTransport(draft: McpPatchDraft, transport: Transport): McpPatchDraft {
	if (transport === draft.transport) return draft;
	const fields = { ...draft.fields };
	const incompatible: readonly PatchField[] =
		transport === "http"
			? ["command", "args", "cwd", "env"]
			: ["url", "http_headers", "oauth", "bearer_token_env_var", "env_http_headers"];
	for (const field of incompatible) fields[field] = { ...fields[field], operation: "remove" };
	const required = transport === "http" ? "url" : "command";
	fields[required] = { ...fields[required], operation: "set" };
	return { ...draft, fields, transport };
}

export function McpEditor(props: {
	readonly editor: Extract<SettingsEditor, { kind: "mcp" }>;
	readonly existing: SettingsMcpServer | undefined;
	readonly onDone: (saved: boolean) => void;
}) {
	const t = useT();
	if (!props.editor.name) return <CreateMcpEditor editor={props.editor} onDone={props.onDone} />;
	if (!props.existing?.revision || !/^[a-f0-9]{64}$/u.test(props.existing.revision))
		return (
			<div className="settings-editor">
				<div role="alert">{t("settingsMcpPatchReload")}</div>
				<Button className="settings-btn" onClick={() => props.onDone(false)}>
					{t("cancel")}
				</Button>
			</div>
		);
	return (
		<ExistingMcpEditor
			key={props.editor.name}
			existing={props.existing}
			jsonMode={Boolean(props.editor.json)}
			onDone={props.onDone}
		/>
	);
}

function ExistingMcpEditor({
	existing,
	jsonMode,
	onDone,
}: {
	readonly existing: SettingsMcpServer;
	readonly jsonMode: boolean;
	readonly onDone: (saved: boolean) => void;
}) {
	const t = useT();
	const id = useId();
	const [draft, setDraft] = useState(() => initialMcpPatchDraft(existing));
	const [mode, setMode] = useState<"form" | "json">(jsonMode ? "json" : "form");
	const [json, setJson] = useState(() => JSON.stringify(mcpPatchFromDraft(draft), null, 2));
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const keptValues = initialMcpPatchDraft(existing).fields;
	const updateField = (field: PatchField, update: Partial<FieldDraft>) => {
		setDraft((current) => ({
			...current,
			fields: { ...current.fields, [field]: { ...current.fields[field], ...update } },
		}));
	};
	const switchMode = (next: "form" | "json") => {
		if (next === mode) return;
		try {
			if (next === "json") setJson(JSON.stringify(mcpPatchFromDraft(draft), null, 2));
			else setDraft(mcpPatchDraftFromJson(json, { ...existing, revision: draft.revision }));
			setError(undefined);
			setMode(next);
		} catch {
			setError(t("settingsMcpPatchInvalid"));
		}
	};
	const save = async (event: FormEvent) => {
		event.preventDefault();
		let patch: McpEditPatch;
		try {
			patch = mcpPatchFromDraft(
				mode === "json" ? mcpPatchDraftFromJson(json, { ...existing, revision: draft.revision }) : draft,
			);
		} catch {
			setError(t("settingsMcpPatchInvalid"));
			return;
		}
		setError(undefined);
		setSaving(true);
		try {
			await apiSend(`/api/v1/settings/mcp/${encodeURIComponent(existing.name)}`, "PUT", { patch });
			// A completed write belongs to this editor, not an editor opened while it was pending.
			if (!active.current) return;
			showError(t("settingsMcpSaved", { name: existing.name }), false);
			onDone(true);
		} catch {
			if (active.current) setError(t("settingsMcpPatchFailed"));
		} finally {
			if (active.current) setSaving(false);
		}
	};
	return (
		<form className="settings-editor" id="settingsMcpEditor" onSubmit={(event) => void save(event)}>
			<nav className="settings-breadcrumb" aria-label={t("settingsMcp")}>
				<Button onClick={() => onDone(false)}>{t("settingsMcp")}</Button>
				<Icon name="chevronRight" size="menu" />
				<span>{existing.name}</span>
			</nav>
			<div className="settings-editor-head">
				<div>
					<h1 className="settings-page-title">{t("settingsMcpEditTitle")}</h1>
					<p className="settings-page-desc">{t("settingsMcpPatchDesc")}</p>
				</div>
				<SegmentedControl
					className="settings-mode-switch"
					value={mode}
					onChange={switchMode}
					items={[
						{ value: "form", label: t("settingsForm") },
						{ value: "json", label: t("settingsMcpJsonLabel") },
					]}
				/>
			</div>
			<div className="settings-card settings-form">
				{mode === "json" ? (
					<textarea
						className="settings-code-input"
						aria-label={t("settingsMcpPatchJson")}
						spellCheck={false}
						rows={20}
						value={json}
						disabled={saving}
						onChange={(event) => setJson(event.target.value)}
					/>
				) : (
					<>
						<div className="settings-field">
							<span>{t("settingsMcpTransport")}</span>
							<SettingsSelect<Transport>
								value={draft.transport}
								ariaLabel={t("settingsMcpTransport")}
								options={[
									{ value: "stdio", label: t("settingsMcpStdio") },
									{ value: "http", label: t("settingsMcpHttp") },
								]}
								onChange={(transport) => setDraft((current) => changeMcpPatchTransport(current, transport))}
							/>
						</div>
						<p className="settings-form-note">{t("settingsMcpPatchValues")}</p>
						{PATCH_FIELDS.map((field) => {
							const change = draft.fields[field];
							const label = t("settingsMcpPatchField", { field });
							return (
								<div className="settings-field" key={field} data-mcp-patch-field={field}>
									<label htmlFor={`${id}-${field}`}>{label}</label>
									{existing.protectedFields?.includes(field) ? (
										<span className="settings-form-note">{t("settingsMcpStoredHidden")}</span>
									) : null}
									<SettingsSelect<PatchOperation>
										value={change.operation}
										ariaLabel={t("settingsMcpPatchAction", { field })}
										options={[
											{ value: "keep", label: t("settingsMcpPatchKeep") },
											{ value: "set", label: t("settingsMcpPatchSet") },
											{ value: "remove", label: t("settingsMcpPatchRemove") },
										]}
										onChange={(operation) => updateField(field, { operation })}
									/>
									<textarea
										id={`${id}-${field}`}
										className="mono"
										rows={2}
										autoComplete="off"
										spellCheck={false}
										value={
											change.operation === "set"
												? change.text
												: change.operation === "keep"
													? keptValues[field].text
													: ""
										}
										disabled={saving || change.operation !== "set"}
										onChange={(event) => updateField(field, { text: event.target.value })}
									/>
								</div>
							);
						})}
					</>
				)}
				{error ? (
					<div className="settings-alert danger" role="alert">
						{error}
					</div>
				) : null}
				<div className="settings-form-footer">
					<span className="settings-form-note">{t("settingsMcpAppliesNextMessage")}</span>
					<Button className="settings-btn" onClick={() => onDone(false)}>
						{t("cancel")}
					</Button>
					<Button type="submit" className="settings-btn primary" disabled={saving || !draft.revision}>
						{saving ? t("settingsSaving") : t("settingsSave")}
					</Button>
				</div>
			</div>
		</form>
	);
}

function CreateMcpEditor({
	editor,
	onDone,
}: {
	readonly editor: Extract<SettingsEditor, { kind: "mcp" }>;
	readonly onDone: (saved: boolean) => void;
}) {
	const t = useT();
	const ids = useId();
	const [mode, setMode] = useState<"form" | "json">(editor.json ? "json" : "form");
	const [form, setForm] = useState<FormState>(() => formFromConfig("", undefined));
	const [json, setJson] = useState(() =>
		editor.json ? IMPORT_SAMPLE : JSON.stringify({ "my-server": { command: "", args: [] } }, null, 2),
	);
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

	const switchMode = (next: "form" | "json") => {
		if (next === mode) return;
		setError(undefined);
		if (next === "json") {
			setJson(JSON.stringify({ [form.name || "my-server"]: compact(configFromForm(form)) }, null, 2));
		} else {
			try {
				const [first] = serversFromJson(json, form.name);
				if (first) setForm(formFromConfig(first[0], first[1] as McpServerConfig));
			} catch {
				setError(t("settingsJsonInvalid", { reason: t("settingsMcpPatchInvalid") }));
				return;
			}
		}
		setMode(next);
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setError(undefined);
		let entries: Array<[string, unknown]>;
		try {
			entries = mode === "form" ? [[form.name.trim(), configFromForm(form)]] : serversFromJson(json, form.name);
		} catch {
			setError(t("settingsJsonInvalid", { reason: t("settingsMcpPatchInvalid") }));
			return;
		}
		setSaving(true);
		const added: string[] = [];
		try {
			for (const [name, config] of entries) {
				await apiSend("/api/v1/settings/mcp", "POST", { name, config });
				added.push(name);
			}
			showError(t("settingsMcpAdded", { names: added.join(", ") }), false);
			onDone(true);
		} catch {
			const failed = entries[added.length]?.[0] ?? "";
			setError(
				added.length > 0
					? t("settingsMcpPartial", {
							added: added.join(", "),
							name: failed,
							reason: t("settingsMcpPatchInvalid"),
						})
					: t("settingsMcpPatchInvalid"),
			);
		} finally {
			setSaving(false);
		}
	};

	const field = (key: string) => `${ids}-${key}`;
	return (
		<form className="settings-editor" onSubmit={(event) => void save(event)} id="settingsMcpEditor">
			<nav className="settings-breadcrumb" aria-label={t("settingsMcp")}>
				<Button type="button" onClick={() => onDone(false)}>
					{t("settingsMcp")}
				</Button>
				<Icon name="chevronRight" size="menu" />
				<span>{editor.json ? t("settingsMcpImportJson") : t("settingsMcpNew")}</span>
			</nav>
			<div className="settings-editor-head">
				<div>
					<h1 className="settings-page-title">{editor.json ? t("settingsMcpImportJson") : t("settingsMcpNew")}</h1>
					<p className="settings-page-desc">
						{mode === "json" ? t("settingsMcpJsonDesc") : t("settingsMcpFormDesc")}
					</p>
				</div>
				<SegmentedControl
					className="settings-mode-switch"
					items={[
						{ value: "form", label: t("settingsForm") },
						{ value: "json", label: t("settingsMcpJsonLabel") },
					]}
					value={mode}
					onChange={switchMode}
				/>
			</div>

			<div className="settings-card settings-form">
				{mode === "json" ? (
					<textarea
						className="settings-code-input"
						aria-label={t("settingsMcpJsonLabel")}
						spellCheck={false}
						rows={14}
						value={json}
						onChange={(event) => setJson(event.target.value)}
					/>
				) : (
					<>
						<div className="settings-form-grid">
							<label className="settings-field" htmlFor={field("name")}>
								<span>{t("settingsName")}</span>
								<input
									id={field("name")}
									value={form.name}
									placeholder="my-server"
									autoComplete="off"
									spellCheck={false}
									required
									onChange={(event) => update({ name: event.target.value })}
								/>
							</label>
							<div className="settings-field">
								<span>{t("settingsMcpTransport")}</span>
								<SettingsSelect<Transport>
									value={form.transport}
									ariaLabel={t("settingsMcpTransport")}
									options={[
										{ value: "stdio", label: t("settingsMcpStdio") },
										{ value: "http", label: t("settingsMcpHttp") },
									]}
									onChange={(transport) => update({ transport })}
								/>
							</div>
						</div>
						{form.transport === "stdio" ? (
							<>
								<label className="settings-field" htmlFor={field("command")}>
									<span>{t("settingsMcpCommand")}</span>
									<input
										id={field("command")}
										className="mono"
										value={form.command}
										placeholder="npx"
										spellCheck={false}
										required
										onChange={(event) => update({ command: event.target.value })}
									/>
								</label>
								<label className="settings-field" htmlFor={field("args")}>
									<span>{t("settingsMcpArgs")}</span>
									<input
										id={field("args")}
										className="mono"
										value={form.args}
										placeholder="-y @modelcontextprotocol/server-memory"
										spellCheck={false}
										onChange={(event) => update({ args: event.target.value })}
									/>
								</label>
								<details className="settings-advanced">
									<summary>
										<Icon name="chevronRight" size="menu" />
										{t("settingsMcpAdvanced")}
									</summary>
									<label className="settings-field" htmlFor={field("env")}>
										<span>{t("settingsMcpEnv")}</span>
										<textarea
											id={field("env")}
											className="mono"
											rows={3}
											value={form.env}
											placeholder="API_KEY=..."
											spellCheck={false}
											onChange={(event) => update({ env: event.target.value })}
										/>
									</label>
									<label className="settings-field" htmlFor={field("cwd")}>
										<span>{t("settingsMcpCwd")}</span>
										<input
											id={field("cwd")}
											className="mono"
											value={form.cwd}
											placeholder="~/projects/tools"
											spellCheck={false}
											onChange={(event) => update({ cwd: event.target.value })}
										/>
									</label>
									<Timeouts form={form} update={update} field={field} />
								</details>
							</>
						) : (
							<>
								<label className="settings-field" htmlFor={field("url")}>
									<span>URL</span>
									<input
										id={field("url")}
										className="mono"
										type="url"
										value={form.url}
										placeholder="https://example.com/mcp"
										spellCheck={false}
										required
										onChange={(event) => update({ url: event.target.value })}
									/>
								</label>
								<details className="settings-advanced">
									<summary>
										<Icon name="chevronRight" size="menu" />
										{t("settingsMcpAdvanced")}
									</summary>
									<label className="settings-field" htmlFor={field("headers")}>
										<span>{t("settingsMcpHeaders")}</span>
										<textarea
											id={field("headers")}
											className="mono"
											rows={3}
											value={form.headers}
											placeholder="X-Api-Key: ..."
											spellCheck={false}
											onChange={(event) => update({ headers: event.target.value })}
										/>
									</label>
									<label className="settings-field" htmlFor={field("bearer")}>
										<span>{t("settingsMcpBearer")}</span>
										<input
											id={field("bearer")}
											className="mono"
											value={form.bearer}
											placeholder="MY_SERVICE_TOKEN"
											spellCheck={false}
											onChange={(event) => update({ bearer: event.target.value })}
										/>
									</label>
									<Timeouts form={form} update={update} field={field} />
								</details>
							</>
						)}
					</>
				)}
				{error ? (
					<div className="settings-alert danger" role="alert">
						{error}
					</div>
				) : null}
				<div className="settings-form-footer">
					<span className="settings-form-note">{t("settingsMcpAppliesNextMessage")}</span>
					<Button type="button" className="settings-btn" onClick={() => onDone(false)}>
						{t("cancel")}
					</Button>
					<Button type="submit" className={cx("settings-btn primary")} disabled={saving}>
						{saving ? t("settingsSaving") : t("settingsSave")}
					</Button>
				</div>
			</div>
		</form>
	);
}

function Timeouts({
	form,
	update,
	field,
}: {
	readonly form: FormState;
	readonly update: (patch: Partial<FormState>) => void;
	readonly field: (key: string) => string;
}) {
	const t = useT();
	return (
		<div className="settings-form-grid">
			<label className="settings-field" htmlFor={field("startup")}>
				<span>{t("settingsMcpStartupTimeout")}</span>
				<input
					id={field("startup")}
					type="number"
					min="1"
					value={form.startupTimeout}
					placeholder="30"
					onChange={(event) => update({ startupTimeout: event.target.value })}
				/>
			</label>
			<label className="settings-field" htmlFor={field("tool")}>
				<span>{t("settingsMcpToolTimeout")}</span>
				<input
					id={field("tool")}
					type="number"
					min="1"
					value={form.toolTimeout}
					placeholder="300"
					onChange={(event) => update({ toolTimeout: event.target.value })}
				/>
			</label>
		</div>
	);
}
