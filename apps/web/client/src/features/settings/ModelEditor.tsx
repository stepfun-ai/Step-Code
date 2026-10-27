/**
 * Create or edit one custom model provider.
 *
 * The form is the one the settings design calls for: Provider ID, display name,
 * API address, API protocol, API key, then the model catalog. The catalog can be
 * typed by hand or filled from the endpoint through 获取可用模型, which asks the
 * address and protocol *currently in the form* — so a provider can be added in
 * one pass instead of saving it first and coming back.
 *
 * A stored key is never sent to the browser, so the key field starts empty on an
 * existing provider and a blank field means "keep the stored key". Removing one
 * is the explicit action next to it.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { type MessageKey, useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { showError } from "../../state/session";
import type { SettingsEditor } from "../../state/store";
import type { DiscoveredModelEntry, SettingsModelProvider } from "../../state/types";
import { Icon, IconButton, Modal, SearchInput, Spinner, Tooltip } from "../../ui";
import { SettingsSelect } from "./parts";

const MODELS_PATH = "/api/v1/settings/models";

/**
 * The protocols the form offers, by the identifier `models.json` stores, with the
 * path each protocol's client appends to the stored address.
 */
const API_CHOICES: ReadonlyArray<{
	readonly value: string;
	readonly label: string;
	readonly placeholder: string;
	readonly requestPath: string;
}> = [
	{
		value: "anthropic-messages",
		label: "Anthropic Messages",
		placeholder: "https://gateway.example",
		requestPath: "/v1/messages",
	},
	{
		value: "openai-responses",
		label: "OpenAI Responses",
		placeholder: "https://gateway.example/v1",
		requestPath: "/responses",
	},
	{
		value: "openai-completions",
		label: "OpenAI Chat Completions",
		placeholder: "https://gateway.example/v1",
		requestPath: "/chat/completions",
	},
];

/**
 * The address the host stores for `api`, for showing the request it leads to.
 *
 * Display-only mirror of `normalizeProviderBaseUrl` in
 * `packages/providers/src/model-discovery.ts`, which the host applies on save and
 * on discovery: OpenAI protocols give a bare root `/v1`, Anthropic drops one
 * trailing `/v1` (its client adds it). Undefined for a value that is not a URL.
 */
function storedBaseUrl(baseUrl: string, api: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	let path = parsed.pathname.replace(/\/+$/u, "");
	if (api === "anthropic-messages") {
		if (path.endsWith("/v1")) path = path.slice(0, -3);
	} else if (path === "") {
		path = "/v1";
	}
	return `${parsed.origin}${path}${parsed.search}${parsed.hash}`;
}

/** One editable catalog row. Numbers stay strings while the user types them. */
interface ModelRowState {
	readonly key: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: string;
	readonly maxTokens: string;
	readonly input: readonly ("text" | "image")[];
	/** Only a stored `false` is kept; every other row is saved as a reasoning model. */
	readonly reasoning?: boolean;
	/** The stored map, kept as is; a row without one is saved with {@link DEFAULT_THINKING_LEVEL_MAP}. */
	readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

/** One row's connection test: in flight, answered, or failed with the reason. */
type ModelTestState = { status: "testing" } | { status: "ok" } | { status: "fail"; error: string };

/**
 * The per-row connection test control: a zap button to start, a spinner while
 * probing, then a coloured answer whose tooltip carries the reason. It answers
 * for the declaration currently in the form, saved or not.
 */
function ModelTestAction({
	state,
	disabled,
	onTest,
}: {
	readonly state: ModelTestState | undefined;
	readonly disabled: boolean;
	readonly onTest: () => void;
}) {
	const t = useT();
	if (state?.status === "testing")
		return (
			<span className="settings-model-test testing" title={t("settingsModelsTest")}>
				<Spinner />
			</span>
		);
	if (state?.status === "ok")
		return (
			<Tooltip content={t("settingsModelsTestOk")}>
				<span className="settings-model-test ok" role="img" aria-label={t("settingsModelsTestOk")}>
					<Icon name="check" size="xs" />
				</span>
			</Tooltip>
		);
	if (state?.status === "fail")
		return (
			<Tooltip content={`${t("settingsModelsTestFailed")}: ${state.error}`}>
				<span className="settings-model-test fail" role="img" aria-label={t("settingsModelsTestFailed")}>
					<Icon name="close" size="xs" />
				</span>
			</Tooltip>
		);
	return (
		<Tooltip content={t("settingsModelsTest")}>
			<IconButton
				icon="zap"
				iconSize="xs"
				className="settings-icon-action"
				aria-label={t("settingsModelsTest")}
				disabled={disabled}
				onClick={onTest}
			/>
		</Tooltip>
	);
}

/**
 * The thinking levels a model saved from this page offers when its own map is
 * not known. A model listing does not say which efforts a model takes, and the
 * kernel offers only "off" for a model without `reasoning`, so every row is
 * saved as a reasoning model with this map: each level is sent by its own name,
 * and `minimal` (`null`) is hidden.
 */
const DEFAULT_THINKING_LEVEL_MAP: Readonly<Record<string, string | null>> = {
	off: "off",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

interface FormState {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly apiKey: string;
	readonly models: readonly ModelRowState[];
}

const EMPTY_FORM: FormState = {
	id: "",
	name: "",
	baseUrl: "",
	api: API_CHOICES[0]?.value ?? "anthropic-messages",
	apiKey: "",
	models: [],
};

let rowSeq = 0;

function newRow(entry?: Partial<ModelRowState>): ModelRowState {
	rowSeq += 1;
	return {
		key: `row-${String(rowSeq)}`,
		id: entry?.id ?? "",
		name: entry?.name ?? "",
		contextWindow: entry?.contextWindow ?? "",
		maxTokens: entry?.maxTokens ?? "",
		// Image input is what a current endpoint usually serves, so a new row
		// starts with it on; a row built from a stored declaration keeps what it says.
		input: entry?.input ?? ["text", "image"],
		...(entry?.reasoning === false ? { reasoning: false } : {}),
		...(entry?.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
	};
}

function formFromProvider(provider: SettingsModelProvider | undefined): FormState {
	if (!provider) return EMPTY_FORM;
	return {
		id: provider.id,
		name: provider.name === provider.id ? "" : provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api || EMPTY_FORM.api,
		// Write-only: the stored key never reaches the browser.
		apiKey: "",
		models: provider.models.map((model) =>
			newRow({
				id: model.id,
				name: model.name ?? "",
				contextWindow: model.contextWindow?.toString() ?? "",
				maxTokens: model.maxTokens?.toString() ?? "",
				input: (model.input ?? ["text"]).filter(
					(value): value is "text" | "image" => value === "text" || value === "image",
				),
				...(model.reasoning === false ? { reasoning: false } : {}),
				...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
			}),
		),
	};
}

/**
 * The context window a row is saved with when its field is left blank. The form
 * writes it into `models.json` rather than leaving the key out, because the
 * runtime's own fallback for a missing value is smaller; the field's placeholder
 * names this number, so it has to be what is stored.
 */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * The request body: rows without an id are dropped rather than rejected.
 *
 * A blank max-output field is written as no `maxTokens` at all, unlike the
 * context window: the kernel then applies its own 16384-token default, which is
 * also what a hand-declared model without the field gets. The field exists
 * because that default is a ceiling on one reply and the thinking budget is
 * spent from the same ceiling, so a long answer or a high effort can end in
 * `stopReason: "length"` until the user raises it.
 */
function modelsPayload(rows: readonly ModelRowState[]): Array<Record<string, unknown>> {
	return rows
		.filter((row) => row.id.trim())
		.map((row) => ({
			id: row.id.trim(),
			...(row.name.trim() ? { name: row.name.trim() } : {}),
			contextWindow: Number(row.contextWindow) > 0 ? Number(row.contextWindow) : DEFAULT_CONTEXT_WINDOW,
			...(Number(row.maxTokens) > 0 ? { maxTokens: Number(row.maxTokens) } : {}),
			...(row.input.length > 0 ? { input: row.input } : {}),
			reasoning: row.reasoning !== false,
			thinkingLevelMap: row.thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAP,
		}));
}

/**
 * Provider ids the host accepts; mirrors `checkProviderId` in
 * `src/model-providers.ts` so the form can say what is wrong before a round trip.
 * The host still validates, and its reply is shown if the two ever drift.
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_PROVIDER_ID = 64;
const RESERVED_PROVIDER_ID = "step";

type CheckedField = "id" | "baseUrl";
type FieldErrors = Partial<Record<CheckedField, MessageKey>>;

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/** The fields the form checks itself, each with the message to show under it. */
function validateForm(form: FormState, editing: boolean): FieldErrors {
	const errors: FieldErrors = {};
	// An existing provider's id is fixed (the input is disabled), so only a new one is checked.
	if (!editing) {
		const id = form.id.trim();
		if (!id) errors.id = "settingsModelsIdRequired";
		else if (!PROVIDER_ID.test(id) || id.length > MAX_PROVIDER_ID) errors.id = "settingsModelsIdInvalid";
		else if (id === RESERVED_PROVIDER_ID) errors.id = "settingsModelsIdReserved";
	}
	const baseUrl = form.baseUrl.trim();
	if (!baseUrl) errors.baseUrl = "settingsModelsBaseUrlRequired";
	else if (!isHttpUrl(baseUrl)) errors.baseUrl = "settingsModelsBaseUrlInvalid";
	return errors;
}

/** A field title, with the red dot that marks a required field. */
function FieldTitle({ text, required = false }: { readonly text: string; readonly required?: boolean }) {
	return (
		<span className="settings-field-label">
			{text}
			{/* The input carries `required`, which is what assistive technology reads. */}
			{required ? <i className="settings-required-dot" aria-hidden="true" /> : null}
		</span>
	);
}

/**
 * The candidate picker 获取可用模型 opens.
 *
 * It is a picker rather than a direct write because the reply is a guess about
 * what the endpoint serves, not a decision: the user sees the ids and their
 * capabilities, chooses, and only then does anything reach the catalog. Already
 * present rows are shown as such and keep the values the user set.
 */
function DiscoverDialog({
	open,
	loading,
	error,
	models,
	selected,
	onToggle,
	onSelectAll,
	onClearAll,
	onAdd,
	onClose,
}: {
	readonly open: boolean;
	readonly loading: boolean;
	readonly error: string | undefined;
	readonly models: readonly DiscoveredModelEntry[];
	readonly selected: ReadonlySet<string>;
	readonly onToggle: (id: string) => void;
	readonly onSelectAll: () => void;
	readonly onClearAll: () => void;
	readonly onAdd: () => void;
	readonly onClose: () => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle ? models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(needle)) : models;
	}, [models, query]);
	return (
		<Modal
			open={open}
			onClose={onClose}
			id="settingsModelDiscover"
			className="settings-dialog settings-discover-dialog"
			labelledBy="settingsModelDiscoverTitle"
		>
			<div className="settings-dialog-head">
				<h2 id="settingsModelDiscoverTitle">{t("settingsModelsDiscover")}</h2>
				<IconButton icon="close" iconSize="sm" aria-label={t("close")} onClick={onClose} />
			</div>
			{loading ? (
				<div className="settings-loading">
					<Spinner />
					<span>{t("settingsModelsDiscoverLoading")}</span>
				</div>
			) : error ? (
				<div className="settings-alert danger" role="alert">
					{error}
				</div>
			) : models.length === 0 ? (
				<p className="settings-dialog-desc">{t("settingsModelsDiscoverEmpty")}</p>
			) : (
				<>
					<div className="settings-modal-tools">
						<SearchInput
							wrapperClassName="settings-search"
							placeholder={t("settingsModelsDiscoverSearch")}
							aria-label={t("settingsModelsDiscoverSearch")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
						<button type="button" className="settings-btn subtle" onClick={onSelectAll}>
							{t("settingsModelsSelectAll")}
						</button>
						<button type="button" className="settings-btn subtle" onClick={onClearAll}>
							{t("settingsModelsClearAll")}
						</button>
					</div>
					<ul className="settings-model-options">
						{visible.map((model) => (
							<li key={model.id}>
								<label className="settings-model-option" data-discovered-model={model.id}>
									<input
										type="checkbox"
										checked={selected.has(model.id)}
										onChange={() => onToggle(model.id)}
									/>
									<span className="settings-model-option-id mono">{model.id}</span>
									<span className="settings-model-option-meta">
										{model.name !== model.id ? model.name : ""}
										{model.contextWindow ? ` \u00b7 ${String(model.contextWindow)}` : ""}
									</span>
								</label>
							</li>
						))}
					</ul>
				</>
			)}
			<div className="settings-dialog-footer">
				<button type="button" className="settings-btn" onClick={onClose}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="settings-btn primary"
					id="settingsModelDiscoverAdd"
					disabled={selected.size === 0}
					onClick={onAdd}
				>
					{t("settingsModelsAddSelected", { count: selected.size })}
				</button>
			</div>
		</Modal>
	);
}

export function ModelEditor({
	editor,
	existing,
	onDone,
}: {
	readonly editor: Extract<SettingsEditor, { kind: "model" }>;
	readonly existing: SettingsModelProvider | undefined;
	readonly onDone: (saved: boolean) => void;
}) {
	const t = useT();
	const editing = Boolean(editor.id);
	const [form, setForm] = useState<FormState>(() => formFromProvider(existing));
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [removeKey, setRemoveKey] = useState(false);
	const [discoverOpen, setDiscoverOpen] = useState(false);
	const [discoverLoading, setDiscoverLoading] = useState(false);
	const [discoverError, setDiscoverError] = useState<string>();
	const [discovered, setDiscovered] = useState<readonly DiscoveredModelEntry[]>([]);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	// A field's error shows once the user has left it or tried to save, so an
	// untouched empty form does not open covered in red.
	const [touched, setTouched] = useState<ReadonlySet<CheckedField>>(new Set());
	const [submitted, setSubmitted] = useState(false);
	const fieldErrors = useMemo(() => validateForm(form, editing), [form, editing]);
	const shownError = (name: CheckedField): MessageKey | undefined =>
		submitted || touched.has(name) ? fieldErrors[name] : undefined;
	const touch = (name: CheckedField) =>
		setTouched((current) => (current.has(name) ? current : new Set(current).add(name)));
	const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
	const apiChoice = API_CHOICES.find((choice) => choice.value === form.api) ?? API_CHOICES[0];

	const runDiscover = useCallback(async () => {
		setDiscoverError(undefined);
		setDiscoverLoading(true);
		setSelected(new Set());
		try {
			// A blank key field means "keep the stored key": the host falls back to
			// the credential stored for this provider id, as the connection test does.
			const reply = await apiSend<{ models: DiscoveredModelEntry[] }>(`${MODELS_PATH}/discover`, "POST", {
				providerId: editing ? editor.id : form.id.trim(),
				baseUrl: form.baseUrl.trim(),
				api: form.api,
				apiKey: form.apiKey.trim() || undefined,
			});
			setDiscovered(reply.models);
		} catch (caught) {
			setDiscovered([]);
			setDiscoverError(errorMessage(caught));
		} finally {
			setDiscoverLoading(false);
		}
	}, [editing, editor.id, form.id, form.baseUrl, form.api, form.apiKey]);

	const openDiscover = () => {
		setDiscoverOpen(true);
		void runDiscover();
	};

	const updateRow = (key: string, patch: Partial<ModelRowState>) =>
		setForm((current) => ({
			...current,
			models: current.models.map((row) => (row.key === key ? { ...row, ...patch } : row)),
		}));

	/** Connection tests started this visit, keyed by row key (rows are re-keyed, not reused). */
	const [tests, setTests] = useState<Record<string, ModelTestState>>({});

	// The probe uses the declaration as it stands in the form — saved or not —
	// with a typed key winning over the stored one, mirroring the save itself.
	const testRow = (row: ModelRowState) => {
		if (!row.id.trim() || tests[row.key]?.status === "testing") return;
		setTests((current) => ({ ...current, [row.key]: { status: "testing" } }));
		void apiSend(`${MODELS_PATH}/test`, "POST", {
			providerId: editing ? editor.id : form.id.trim(),
			baseUrl: form.baseUrl.trim(),
			api: form.api,
			apiKey: form.apiKey.trim() || undefined,
			modelId: row.id.trim(),
		})
			.then(() => setTests((current) => ({ ...current, [row.key]: { status: "ok" } })))
			.catch((caught: unknown) => {
				setTests((current) => ({ ...current, [row.key]: { status: "fail", error: errorMessage(caught) } }));
			});
	};

	// Selected candidates become editable rows, keeping what the endpoint said and
	// leaving any row the user already adjusted alone.
	const addSelected = () => {
		const have = new Set(form.models.map((row) => row.id.trim()).filter(Boolean));
		const additions = discovered
			.filter((model) => selected.has(model.id) && !have.has(model.id))
			.map((model) =>
				newRow({
					id: model.id,
					name: model.name === model.id ? "" : model.name,
					contextWindow: model.contextWindow?.toString() ?? "",
					maxTokens: model.maxTokens?.toString() ?? "",
				}),
			);
		update({ models: [...form.models, ...additions] });
		setDiscoverOpen(false);
	};

	useEffect(() => {
		// A dialog left mounted keeps its last reply; clearing here keeps the next
		// open from showing a catalog the form no longer describes.
		if (discoverOpen) return;
		setDiscovered([]);
		setDiscoverError(undefined);
		setSelected(new Set());
	}, [discoverOpen]);

	const field = (key: string) => `settingsModel-${key}`;
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setError(undefined);
		setSubmitted(true);
		const firstInvalid = (["id", "baseUrl"] as const).find((name) => fieldErrors[name]);
		if (firstInvalid) {
			document.getElementById(field(firstInvalid))?.focus();
			return;
		}
		setSaving(true);
		const id = editing ? (editor.id ?? "") : form.id.trim();
		try {
			const body = {
				name: form.name.trim() || undefined,
				baseUrl: form.baseUrl.trim(),
				api: form.api,
				apiKey: form.apiKey.trim() || undefined,
				models: modelsPayload(form.models),
			};
			if (editing) await apiSend(`${MODELS_PATH}/${encodeURIComponent(id)}`, "PUT", { ...body, removeKey });
			else await apiSend(MODELS_PATH, "POST", { id, ...body });
			showError(t(editing ? "settingsModelsSaved" : "settingsModelsAdded", { name: form.name.trim() || id }), false);
			onDone(true);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSaving(false);
		}
	};

	const idError = shownError("id");
	const baseUrlError = shownError("baseUrl");
	const storedUrl = storedBaseUrl(form.baseUrl, form.api);
	const requestUrl = storedUrl && apiChoice ? `${storedUrl}${apiChoice.requestPath}` : undefined;
	return (
		<>
			{/* noValidate: the fields show their own messages instead of the browser's bubble. */}
			<form className="settings-editor" id="settingsModelEditor" noValidate onSubmit={(event) => void save(event)}>
				<nav className="settings-breadcrumb" aria-label={t("settingsModels")}>
					<button type="button" onClick={() => onDone(false)}>
						{t("settingsModels")}
					</button>
					<Icon name="chevronRight" size="menu" />
					<span>{editing ? (editor.id ?? "") : t("settingsModelsNew")}</span>
				</nav>
				<div className="settings-editor-head">
					<div>
						<h1 className="settings-page-title">
							{editing ? t("settingsModelsEditTitle") : t("settingsModelsNew")}
						</h1>
						<p className="settings-page-desc">{t("settingsModelsFormDesc")}</p>
					</div>
				</div>

				<div className="settings-card settings-form">
					<label className="settings-field" htmlFor={field("id")}>
						<FieldTitle text="Provider ID" required={!editing} />
						<input
							id={field("id")}
							className="mono"
							value={form.id}
							disabled={editing}
							placeholder="model-proxy"
							autoComplete="off"
							spellCheck={false}
							required
							aria-invalid={idError ? true : undefined}
							aria-describedby={field("id-message")}
							onBlur={() => touch("id")}
							onChange={(event) => update({ id: event.target.value })}
						/>
						<small id={field("id-message")} className={idError ? "settings-field-error" : "settings-field-hint"}>
							{t(idError ?? "settingsModelsIdHint")}
						</small>
					</label>
					<label className="settings-field" htmlFor={field("name")}>
						<FieldTitle text={t("settingsModelsDisplayName")} />
						<input
							id={field("name")}
							value={form.name}
							placeholder={t("settingsModelsDisplayName")}
							autoComplete="off"
							onChange={(event) => update({ name: event.target.value })}
						/>
					</label>
					<label className="settings-field" htmlFor={field("baseUrl")}>
						<FieldTitle text={t("settingsModelsBaseUrl")} required />
						<input
							id={field("baseUrl")}
							className="mono"
							value={form.baseUrl}
							placeholder="https://gateway.example"
							spellCheck={false}
							required
							aria-invalid={baseUrlError ? true : undefined}
							aria-describedby={field("baseUrl-message")}
							onBlur={() => touch("baseUrl")}
							onChange={(event) => update({ baseUrl: event.target.value })}
						/>
						{baseUrlError ? (
							<small id={field("baseUrl-message")} className="settings-field-error">
								{t(baseUrlError)}
							</small>
						) : (
							<small id={field("baseUrl-message")} className="settings-field-hint">
								{requestUrl ? (
									<>
										{t("settingsModelsBaseUrlRequest")}
										<span className="mono">{requestUrl}</span>
									</>
								) : (
									t("settingsModelsBaseUrlHint")
								)}
							</small>
						)}
					</label>
					<div className="settings-field settings-field-narrow">
						<FieldTitle text={t("settingsModelsApi")} required />
						<SettingsSelect<string>
							id={field("api")}
							value={form.api}
							ariaLabel={t("settingsModelsApi")}
							options={API_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
							onChange={(api) => update({ api })}
						/>
					</div>
					<label className="settings-field" htmlFor={field("apiKey")}>
						<FieldTitle text={t("settingsModelsApiKey")} required />
						<input
							id={field("apiKey")}
							type="password"
							className="mono"
							value={form.apiKey}
							autoComplete="new-password"
							placeholder={
								editing && existing?.credential !== "none"
									? t("settingsModelsApiKeyKeep")
									: t("settingsModelsApiKeyPlaceholder")
							}
							onChange={(event) => {
								setRemoveKey(false);
								update({ apiKey: event.target.value });
							}}
						/>
					</label>

					<hr className="settings-divider" />
					<div className="settings-field-head">
						<span className="settings-field-title">{t("settingsModelsCatalog")}</span>
						<button
							type="button"
							className="settings-btn subtle"
							id="settingsModelDiscoverButton"
							disabled={!form.baseUrl.trim()}
							onClick={openDiscover}
						>
							<Icon name="refresh" size="xs" />
							{t("settingsModelsDiscover")}
						</button>
					</div>
					{form.models.length === 0 ? (
						<div className="settings-dashed-note" id="settingsModelsCatalogEmpty">
							{t("settingsModelsCatalogEmpty")}
						</div>
					) : (
						<ul className="settings-model-rows">
							{form.models.map((row) => (
								<li className="settings-model-row" data-model-row={row.id || row.key} key={row.key}>
									<label className="settings-model-field">
										<span>{t("settingsModelsModelId")}</span>
										<input
											className="mono"
											data-model-field="id"
											value={row.id}
											placeholder="model-id"
											spellCheck={false}
											onChange={(event) => updateRow(row.key, { id: event.target.value })}
										/>
									</label>
									<label className="settings-model-field">
										<span>{t("settingsModelsModelName")}</span>
										<input
											data-model-field="name"
											value={row.name}
											placeholder={t("settingsModelsModelName")}
											onChange={(event) => updateRow(row.key, { name: event.target.value })}
										/>
									</label>
									<label className="settings-model-field">
										<span>{t("settingsModelsContextWindow")}</span>
										<input
											type="number"
											min="1"
											data-model-field="contextWindow"
											value={row.contextWindow}
											placeholder={t("settingsModelsContextWindowPlaceholder")}
											onChange={(event) => updateRow(row.key, { contextWindow: event.target.value })}
										/>
									</label>
									{/* The kernel's own default is smaller than a long answer needs,
									    and it is shared with the thinking budget; say so once, here. */}
									<label className="settings-model-field">
										<Tooltip content={t("settingsModelsMaxTokensHint")}>
											<span>{t("settingsModelsMaxTokens")}</span>
										</Tooltip>
										<input
											type="number"
											min="1"
											data-model-field="maxTokens"
											value={row.maxTokens}
											placeholder={t("settingsModelsMaxTokensPlaceholder")}
											onChange={(event) => updateRow(row.key, { maxTokens: event.target.value })}
										/>
									</label>
									<div className="settings-model-field">
										<span>{t("settingsModelsInputTypes")}</span>
										<label className="settings-inline-check">
											<input
												type="checkbox"
												checked={row.input.includes("image")}
												onChange={() =>
													updateRow(row.key, {
														input: row.input.includes("image") ? ["text"] : ["text", "image"],
													})
												}
											/>
											{t("settingsModelsImageInput")}
										</label>
									</div>
									<ModelTestAction
										state={tests[row.key]}
										disabled={!row.id.trim() || !form.baseUrl.trim()}
										onTest={() => testRow(row)}
									/>
									<Tooltip content={t("settingsDelete")}>
										<button
											type="button"
											className="settings-icon-action danger"
											aria-label={t("settingsDelete")}
											onClick={() =>
												update({ models: form.models.filter((candidate) => candidate.key !== row.key) })
											}
										>
											<Icon name="trash" size="xs" />
										</button>
									</Tooltip>
								</li>
							))}
						</ul>
					)}
					<button
						type="button"
						className="settings-dashed-add"
						id="settingsModelAddRow"
						onClick={() => update({ models: [...form.models, newRow()] })}
					>
						<Icon name="plus" size="xs" />
						{t("settingsModelsAddModel")}
					</button>

					{error ? (
						<div className="settings-alert danger" role="alert">
							{error}
						</div>
					) : null}
					<div className="settings-form-footer">
						<span className="settings-form-note">{t("settingsModelsFootnote")}</span>
						<button type="button" className="settings-btn" onClick={() => onDone(false)}>
							{t("cancel")}
						</button>
						<button type="submit" className="settings-btn primary" disabled={saving}>
							{saving ? t("settingsSaving") : editing ? t("settingsSave") : t("settingsModelsCreate")}
						</button>
					</div>
				</div>
			</form>
			<DiscoverDialog
				open={discoverOpen}
				loading={discoverLoading}
				error={discoverError}
				models={discovered}
				selected={selected}
				onToggle={(id) =>
					setSelected((current) => {
						const next = new Set(current);
						if (next.has(id)) next.delete(id);
						else next.add(id);
						return next;
					})
				}
				onSelectAll={() => setSelected(new Set(discovered.map((model) => model.id)))}
				onClearAll={() => setSelected(new Set())}
				onAdd={addSelected}
				onClose={() => setDiscoverOpen(false)}
			/>
		</>
	);
}
