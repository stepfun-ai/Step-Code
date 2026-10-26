/**
 * Create or edit an MCP server. The form covers the common fields; the JSON tab
 * takes the same declaration as text, including the `mcpServers` object other
 * clients export, so several servers can be imported at once.
 *
 * Fields the form does not show (tool allow/deny lists, env-sourced headers,
 * OAuth) ride along in `FormState.hidden`, so a form save or a form/JSON switch
 * writes them back instead of dropping them: losing `enabled_tools` would
 * expose every tool of the server.
 */

import { type FormEvent, useId, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { showError } from "../../state/session";
import type { SettingsEditor } from "../../state/store";
import type { McpServerConfig, SettingsMcpServer } from "../../state/types";
import { Icon, SegmentedControl } from "../../ui";
import { SettingsSelect } from "./parts";

type Transport = "stdio" | "http";

/** Declaration fields with no form control, kept as loaded. */
type HiddenFields = Pick<McpServerConfig, "enabled_tools" | "disabled_tools" | "env_http_headers" | "oauth">;

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
		},
	};
}

export function configFromForm(form: FormState): McpServerConfig {
	const timeouts = {
		startup_timeout_sec: numberOrUndefined(form.startupTimeout),
		tool_timeout_sec: numberOrUndefined(form.toolTimeout),
		enabled_tools: form.hidden.enabled_tools,
		disabled_tools: form.hidden.disabled_tools,
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
 * config (named by the form). Claude-style `headers` becomes `http_headers`;
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

export function McpEditor({
	editor,
	existing,
	onDone,
}: {
	readonly editor: Extract<SettingsEditor, { kind: "mcp" }>;
	readonly existing: SettingsMcpServer | undefined;
	readonly onDone: (saved: boolean) => void;
}) {
	const t = useT();
	const ids = useId();
	const editing = Boolean(editor.name);
	const [mode, setMode] = useState<"form" | "json">(editor.json ? "json" : "form");
	const [form, setForm] = useState<FormState>(() => formFromConfig(editor.name ?? "", existing?.config));
	const [json, setJson] = useState(() =>
		editor.json && !editing
			? IMPORT_SAMPLE
			: JSON.stringify(
					{ [editor.name || "my-server"]: compact(existing?.config ?? { command: "", args: [] }) },
					null,
					2,
				),
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
				if (first) setForm(formFromConfig(editing ? form.name : first[0], first[1] as McpServerConfig));
			} catch (caught) {
				setError(t("settingsJsonInvalid", { reason: errorMessage(caught) }));
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
		} catch (caught) {
			setError(t("settingsJsonInvalid", { reason: errorMessage(caught) }));
			return;
		}
		if (editing && (entries.length !== 1 || (mode === "json" && entries[0]?.[0] !== editor.name))) {
			setError(t("settingsMcpEditOne", { name: editor.name ?? "" }));
			return;
		}
		setSaving(true);
		const added: string[] = [];
		try {
			for (const [name, config] of entries) {
				// Keep a server switched off when its declaration is edited.
				const withState = existing?.enabled === false ? { ...(config as object), enabled: false } : config;
				if (editing)
					await apiSend(`/api/v1/settings/mcp/${encodeURIComponent(name)}`, "PUT", { config: withState });
				else await apiSend("/api/v1/settings/mcp", "POST", { name, config: withState });
				added.push(name);
			}
			showError(
				editing
					? t("settingsMcpSaved", { name: editor.name ?? "" })
					: t("settingsMcpAdded", { names: added.join(", ") }),
				false,
			);
			onDone(true);
		} catch (caught) {
			const failed = entries[added.length]?.[0] ?? "";
			setError(
				added.length > 0
					? t("settingsMcpPartial", { added: added.join(", "), name: failed, reason: errorMessage(caught) })
					: errorMessage(caught),
			);
		} finally {
			setSaving(false);
		}
	};

	const field = (key: string) => `${ids}-${key}`;
	return (
		<form className="settings-editor" onSubmit={(event) => void save(event)} id="settingsMcpEditor">
			<nav className="settings-breadcrumb" aria-label={t("settingsMcp")}>
				<button type="button" onClick={() => onDone(false)}>
					{t("settingsMcp")}
				</button>
				<Icon name="chevronRight" size="menu" />
				<span>{editing ? editor.name : editor.json ? t("settingsMcpImportJson") : t("settingsMcpNew")}</span>
			</nav>
			<div className="settings-editor-head">
				<div>
					<h1 className="settings-page-title">
						{editing ? t("settingsMcpEditTitle") : editor.json ? t("settingsMcpImportJson") : t("settingsMcpNew")}
					</h1>
					<p className="settings-page-desc">
						{mode === "json" ? t("settingsMcpJsonDesc") : t("settingsMcpFormDesc")}
					</p>
				</div>
				<SegmentedControl
					className="settings-mode-switch"
					items={[
						{ value: "form", label: t("settingsForm") },
						{ value: "json", label: "JSON" },
					]}
					value={mode}
					onChange={switchMode}
				/>
			</div>

			<div className="settings-card settings-form">
				{mode === "json" ? (
					<textarea
						className="settings-code-input"
						aria-label="JSON"
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
									disabled={editing}
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
					<button type="button" className="settings-btn" onClick={() => onDone(false)}>
						{t("cancel")}
					</button>
					<button type="submit" className={cx("settings-btn primary")} disabled={saving}>
						{saving ? t("settingsSaving") : t("settingsSave")}
					</button>
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
