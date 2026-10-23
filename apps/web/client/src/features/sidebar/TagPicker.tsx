import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { TAG_COLOR_NAMES, type TagColor, useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { getState, shallowEqual, useAppStore } from "../../state/store";
import { Icon } from "../../ui";
import { closeTagPicker, createGroupAndTag, setSessionTag } from "./actions";
import { GroupRenameInput } from "./GroupRenameInput";
import { cssVar, TAG_COLOR_KEYS, TAG_COLORS } from "./tags";

/** The "name the new group" row (legacy `showTagNameInput`, 1062-1080). */
function TagNameInput({ sessionId, color }: { readonly sessionId: string; readonly color: TagColor }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();
	const [error, setError] = useState(false);
	useEffect(() => input.current?.focus(), []);
	const accept = () => {
		const fallback = TAG_COLOR_NAMES[getState().locale][color];
		const name = input.current?.value.trim() || fallback;
		// Identical names leave the colour as the only difference between two
		// groups, which the picker and grouped view cannot show apart.
		const duplicate = getState().groups.some((group) => group.name.toLowerCase() === name.toLowerCase());
		if (duplicate) {
			setError(true);
			input.current?.focus();
			input.current?.select();
			return;
		}
		createGroupAndTag(sessionId, color, name);
		closeTagPicker();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// Keeps the document shortcuts (and the Escape chain) out of the name field.
		event.stopPropagation();
		if (event.key === "Enter" && !ime.isComposing(event)) accept();
		if (event.key === "Escape") closeTagPicker();
	};
	return (
		<div className="tag-create">
			<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[color])} />
			<input
				ref={input}
				id="tagNameInput"
				maxLength={12}
				placeholder={t("groupNamePlaceholder")}
				aria-invalid={error || undefined}
				{...ime.handlers}
				onInput={() => setError(false)}
				onKeyDown={onKeyDown}
			/>
			<button type="button" id="tagNameConfirm" onClick={accept}>
				{t("confirm")}
			</button>
			{error ? (
				<div className="tag-create-error" role="alert">
					{t("groupNameDuplicate")}
				</div>
			) : null}
		</div>
	);
}

/**
 * Content of `#tagPicker`: choose, create or clear a session's group (legacy
 * `openTagPicker`, 1014-1060). Mounted on open, so every open starts from the group list.
 */
export function TagPicker({ sessionId }: { readonly sessionId: string }) {
	const t = useT();
	const data = useAppStore((state) => ({ groups: state.groups, tags: state.tags }), shallowEqual);
	const [creating, setCreating] = useState<TagColor | null>(null);
	const [renaming, setRenaming] = useState<TagColor | null>(null);
	if (creating) return <TagNameInput sessionId={sessionId} color={creating} />;

	const used = new Set(data.groups.map((group) => group.key));
	const fresh = TAG_COLOR_KEYS.filter((color) => !used.has(color));
	const choose = (tag: TagColor | "") => {
		if (!tag || data.tags.get(sessionId) === tag) setSessionTag(sessionId, null);
		else setSessionTag(sessionId, tag);
		closeTagPicker();
	};
	return (
		<>
			{data.groups.map((group) =>
				renaming === group.key ? (
					<GroupRenameInput key={group.key} group={group} onDone={() => setRenaming(null)} />
				) : (
					// A div wrapper: the row is a button, and the rename pencil cannot nest in one.
					<div className="group-option" key={group.key}>
						<button type="button" data-tag={group.key} onClick={() => choose(group.key)}>
							<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[group.key])} />
							<span>{group.name}</span>
						</button>
						<button
							type="button"
							className="group-rename-button"
							title={t("renameGroup")}
							aria-label={t("renameGroup")}
							onClick={() => setRenaming(group.key)}
						>
							<Icon name="pencil" size="xs" />
						</button>
					</div>
				),
			)}
			{fresh.length ? (
				<>
					<div className="tag-picker-caption">{t("createGroup")}</div>
					{/* Colour chips instead of wordy rows: one row of swatches, one click each. */}
					<div className="tag-new-colors">
						{fresh.map((color) => {
							const label = t("createWithColor", { color: TAG_COLOR_NAMES[getState().locale][color] });
							return (
								<button
									key={color}
									type="button"
									className="tag-swatch"
									data-new-tag={color}
									style={cssVar("--tag-color", TAG_COLORS[color])}
									title={label}
									aria-label={label}
									onClick={() => setCreating(color)}
								/>
							);
						})}
					</div>
				</>
			) : null}
			<div className="tag-picker-divider" />
			<button type="button" data-tag="" onClick={() => choose("")}>
				<span className="tag-diamond" />
				<span>{t("noCategory")}</span>
			</button>
		</>
	);
}
