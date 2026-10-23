/**
 * `#modelMenu`: one panel for model and thinking effort, showing one provider
 * at a time (legacy app.js 2558-2826, `populateModels` 2987-2990).
 *
 * The provider row at the top swaps the list to the provider picker; picking a
 * provider lands on the model last used under it, so a provider switch is one
 * click and a model switch at most two.
 */

import { useState } from "react";
import { useT } from "../../i18n";
import { modelKey } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { openSettings } from "../settings/actions";
import { selectEffort, selectModel } from "./actions";
import { ControlMenu } from "./ControlOption";
import { ModelPanel, type ModelPanelView } from "./ModelPanel";
import {
	draftModelSource,
	groupModelsByProvider,
	type ModelSource,
	modelLabelParts,
	providerSwitchTarget,
	readLastModelByProvider,
	readPinnedModels,
	rememberModelChoice,
	togglePinnedModel,
} from "./models";
import type { ComposerMenuProps } from "./PolicyMenu";

export function ModelMenu({ open, onOpen, onClose }: ComposerMenuProps) {
	const t = useT();
	const current = useAppStore((state) => state.current);
	const draft = useAppStore(
		(state) => ({ models: state.draftModels, model: state.draftModel, effort: state.draftThinking }),
		shallowEqual,
	);
	const [view, setView] = useState<ModelPanelView>("models");
	const [query, setQuery] = useState("");
	/** Bumped whenever legacy rebuilt (and refocused) the search field. */
	const [searchEpoch, setSearchEpoch] = useState(0);
	/** Favourited models, re-read on open so another tab's pick shows up. */
	const [pinned, setPinned] = useState<readonly string[]>(readPinnedModels);
	// A draft paints the host's prediction for its first session, so the label
	// and panel show the model and effort that session will actually start on.
	const source: ModelSource = current ?? draftModelSource(draft.models, draft.model, draft.effort);

	const labelParts = source.model ? modelLabelParts(t, source) : undefined;

	const resetSearch = () => {
		setQuery("");
		setSearchEpoch((epoch) => epoch + 1);
	};

	const switchProvider = (provider: string) => {
		const group = groupModelsByProvider(source.models ?? []).find((candidate) => candidate.provider === provider);
		if (!group) return;
		// Already on this provider: the model list is what the user came for.
		if (source.model && source.model.provider === provider) {
			setView("models");
			return;
		}
		const target = providerSwitchTarget(group, readLastModelByProvider()[provider]);
		if (!target) return;
		void selectModel(modelKey(target)).then((applied) => {
			if (applied) {
				rememberModelChoice(provider, modelKey(target));
				setView("models");
			}
		});
	};

	return (
		<ControlMenu
			id="modelMenu"
			triggerId="modelTrigger"
			triggerClassName="model-control"
			title="模型与思考强度"
			icon="cube"
			labelId="modelLabel"
			// Before the draft's prediction arrives there is no model to name yet.
			// A long name is cut with an ellipsis instead of pushing the controls on
			// its left; the hover title and the panel still show it in full.
			label={
				labelParts ? (
					<>
						<span className="model-control-name" title={labelParts.name}>
							{labelParts.name}
						</span>
						{labelParts.effort ? <span className="model-control-effort">{labelParts.effort}</span> : null}
					</>
				) : (
					"默认模型"
				)
			}
			popoverId="modelPopover"
			// The trigger sits at the composer's right edge and its width varies with the
			// name, so the panel lines up with its right edge rather than run past the window.
			placement="top-end"
			open={open}
			onOpen={() => {
				// Always open on the model list; the provider picker is a deliberate step.
				setView("models");
				setQuery("");
				setPinned(readPinnedModels());
				onOpen();
			}}
			onClose={onClose}
		>
			<ModelPanel
				source={source}
				view={view}
				query={query}
				searchEpoch={searchEpoch}
				pinned={pinned}
				onQuery={setQuery}
				onView={(next) => {
					setView(next);
					resetSearch();
				}}
				onPinModel={(key) => setPinned(togglePinnedModel(key))}
				onSelectModel={(value) => {
					void selectModel(value).then((applied) => {
						if (applied) {
							// `value` is `provider\0id`; remember it so switching back to this
							// provider later returns to this model.
							const [provider] = value.split("\u0000");
							rememberModelChoice(provider, value);
							onClose();
						}
					});
				}}
				onSelectEffort={(level) => {
					void selectEffort(level).then((applied) => {
						if (applied) onClose();
					});
				}}
				onSelectProvider={switchProvider}
				onManageProviders={() => {
					onClose();
					openSettings("models");
				}}
			/>
		</ControlMenu>
	);
}
