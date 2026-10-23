/**
 * `#modelPopover` (legacy `renderModelPicker`, app.js 2558-2807): the panel
 * shows one provider at a time. The provider row at the top opens the provider
 * list **beside** the model list — both panels stay visible, so a pick shows
 * immediately what the model list switches to.
 *
 * The model and its effort are chosen together in this one popover because the
 * kernel only exposes the levels a given model supports.
 */

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { modelKey } from "../../state/session";
import { Icon, SearchInput, SegmentedControl } from "../../ui";
import { ControlOption, PopoverGroupLabel, PopoverHint } from "./ControlOption";
import type { ModelGroup } from "./models";
import {
	currentProviderGroup,
	effortLabel,
	filterModels,
	groupModelsByProvider,
	MODEL_SEARCH_THRESHOLD,
	type ModelSource,
	modelMeta,
	pinFirst,
} from "./models";

export type ModelPanelView = "models" | "providers";

export interface ModelPanelProps {
	readonly source: ModelSource;
	readonly view: ModelPanelView;
	readonly query: string;
	/** Changes whenever the search field should be emptied and refocused. */
	readonly searchEpoch: number;
	/** Model keys the user favourited; each pins to the top of its provider's list. */
	readonly pinned: readonly string[];
	readonly onQuery: (query: string) => void;
	readonly onView: (view: ModelPanelView) => void;
	readonly onSelectModel: (value: string) => void;
	readonly onPinModel: (key: string) => void;
	readonly onSelectEffort: (level: string) => void;
	readonly onSelectProvider: (provider: string) => void;
	/** "管理模型": open the settings page that manages providers. */
	readonly onManageProviders: () => void;
}

export function ModelPanel(props: ModelPanelProps) {
	const {
		source,
		view,
		query,
		searchEpoch,
		pinned,
		onQuery,
		onView,
		onSelectModel,
		onPinModel,
		onSelectEffort,
		onSelectProvider,
		onManageProviders,
	} = props;
	const t = useT();
	const groups = groupModelsByProvider(source.models ?? []);
	const currentKey = source.model ? modelKey(source.model) : "";
	const provider = currentProviderGroup(source, groups);
	const models = provider ? filterModels(pinFirst(provider.models, pinned), query) : [];
	// A large gateway needs a search field; a handful of models does not.
	const searchable = (provider?.models.length ?? 0) > MODEL_SEARCH_THRESHOLD;
	const main = provider ? (
		<>
			<ProviderRow
				group={provider}
				open={view === "providers"}
				onToggle={() => onView(view === "providers" ? "models" : "providers")}
			/>
			{searchable ? <ModelSearch key={searchEpoch} query={query} onQuery={onQuery} /> : null}
			{/* Only the rows scroll, so the provider row, search and controls stay in view. */}
			<div className="model-popover-list">
				<PopoverGroupLabel>{t("modelsSection")}</PopoverGroupLabel>
				{models.length ? (
					models.map((model) => {
						const key = modelKey(model);
						return (
							<ControlOption
								key={key}
								id={key}
								title={model.name || model.id}
								// The id only adds information when the model has a display name of its own.
								description={model.name && model.name !== model.id ? model.id : undefined}
								meta={modelMeta(model)}
								selected={key === currentKey}
								pinned={pinned.includes(key)}
								onPin={() => onPinModel(key)}
								onSelect={onSelectModel}
							/>
						);
					})
				) : (
					<PopoverHint>{t("noModels")}</PopoverHint>
				)}
			</div>
			<div className="control-popover-section">
				<span className="control-segmented-label">{t("thinkingEffort")}</span>
				{(source.availableThinkingLevels ?? []).length ? (
					<SegmentedControl
						bare
						className="control-segmented-group"
						role="group"
						aria-label={t("thinkingEffort")}
						itemClassName="control-segment"
						items={(source.availableThinkingLevels ?? []).map((level) => ({
							value: level,
							label: effortLabel(t, level),
						}))}
						value={source.thinkingLevel ?? null}
						onChange={onSelectEffort}
					/>
				) : (
					// biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a <fieldset> brings its own border and padding.
					<div className="control-segmented-group" role="group" aria-label={t("thinkingEffort")}>
						{/* No levels means the model cannot adjust effort at all; say so rather than an empty row. */}
						<span className="control-segment-none">{t("effortUnsupported")}</span>
					</div>
				)}
			</div>
		</>
	) : (
		<PopoverHint>{t("noModels")}</PopoverHint>
	);
	if (view !== "providers" || !provider) return main;
	// The model card keeps its place, and the provider list floats OUT beside
	// it — on the right by default, to the left when the window has no room
	// there. It rides in the same popover DOM so an outside press closes both.
	return (
		<>
			{main}
			<ProviderSidePanel>
				<div className="model-popover-list">
					<PopoverGroupLabel>{t("chooseProvider")}</PopoverGroupLabel>
					{groups.map((group) => (
						<ControlOption
							key={group.provider}
							id={group.provider}
							icon={group.source === "account" ? "stepPlatform" : "cube"}
							title={providerGroupLabel(t, group)}
							// A declared name that differs from the id is worth a sub-line; an
							// id repeated below its own fallback title would read as a stutter.
							description={
								group.source === "custom" && group.name !== group.provider ? group.provider : undefined
							}
							selected={group.models.some((model) => modelKey(model) === currentKey)}
							onSelect={onSelectProvider}
						/>
					))}
				</div>
				<button type="button" className="control-popover-more" onClick={onManageProviders}>
					<Icon name="settings" size="sm" />
					<span>{t("manageModels")}</span>
				</button>
			</ProviderSidePanel>
		</>
	);
}

/**
 * The provider list beside the model card, on its right when the window has
 * the room and mirrored to its left when it does not. Measured in a layout
 * effect, before paint, so the panel never flashes on the wrong side.
 */
function ProviderSidePanel({ children }: { readonly children: ReactNode }) {
	const panel = useRef<HTMLDivElement | null>(null);
	const [left, setLeft] = useState(false);
	useLayoutEffect(() => {
		const node = panel.current;
		if (!node) return;
		setLeft(node.getBoundingClientRect().right > window.innerWidth - 8);
	}, []);
	return (
		<div ref={panel} className={cx("model-popover-side", left && "model-popover-side-left")}>
			{children}
		</div>
	);
}

/** A provider's section title, the account's keeps its product label. */
export function providerGroupLabel(t: (key: string) => string, group: Pick<ModelGroup, "source" | "name">): string {
	return group.source === "account" ? t("modelsFromAccount") : group.name;
}

/** The provider entry at the top of the panel: name, badge, and the way to the provider list. */
function ProviderRow({
	group,
	open,
	onToggle,
}: {
	readonly group: ModelGroup;
	readonly open: boolean;
	readonly onToggle: () => void;
}) {
	const t = useT();
	return (
		<button
			type="button"
			className="control-option control-option-provider"
			aria-expanded={open ? "true" : "false"}
			onClick={onToggle}
		>
			<Icon name={group.source === "account" ? "stepPlatform" : "cube"} className="control-option-icon" />
			<span className="control-option-body">
				<span className="control-option-title">
					{providerGroupLabel(t, group)}
					{group.source === "custom" ? (
						<span className="control-option-badge">{t("providerBadgeCustom")}</span>
					) : null}
				</span>
			</span>
			<Icon name={open ? "chevron" : "chevronRight"} size="sm" className="control-option-more-indicator" />
		</button>
	);
}

/** `.control-popover-search`, focused on the frame after it appears (legacy `requestAnimationFrame`). */
function ModelSearch({ query, onQuery }: { readonly query: string; readonly onQuery: (query: string) => void }) {
	const t = useT();
	const input = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => input.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<SearchInput
			bare
			ref={input}
			wrapperClassName="control-popover-search"
			iconSize="sm"
			placeholder={t("searchModels")}
			aria-label={t("searchModels")}
			value={query}
			onChange={(event) => onQuery(event.target.value)}
		/>
	);
}
