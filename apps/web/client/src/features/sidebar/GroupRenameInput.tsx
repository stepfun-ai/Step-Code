import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { getState } from "../../state/store";
import type { TagGroup } from "../../state/types";
import { renameGroup } from "./actions";
import { cssVar, TAG_COLORS } from "./tags";

/**
 * The rename row of an existing group: same shape as the create row, starting
 * from the current name. An empty or unchanged name just closes the row.
 * Mounted inside `#tagPicker` and in place of a grouped-view section heading.
 */
export function GroupRenameInput({ group, onDone }: { readonly group: TagGroup; readonly onDone: () => void }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();
	const [error, setError] = useState(false);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const accept = () => {
		const name = input.current?.value.trim();
		if (!name || name === group.name) {
			onDone();
			return;
		}
		const duplicate = getState().groups.some(
			(candidate) => candidate.key !== group.key && candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (duplicate) {
			setError(true);
			input.current?.focus();
			input.current?.select();
			return;
		}
		renameGroup(group.key, name);
		onDone();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// Keeps the document shortcuts (and the Escape chain) out of the name field.
		event.stopPropagation();
		if (event.key === "Enter" && !ime.isComposing(event)) accept();
		if (event.key === "Escape") onDone();
	};
	return (
		<div className="tag-create">
			<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[group.key])} />
			<input
				ref={input}
				id="groupNameInput"
				maxLength={12}
				defaultValue={group.name}
				aria-label={t("renameGroup")}
				aria-invalid={error || undefined}
				{...ime.handlers}
				onInput={() => setError(false)}
				onKeyDown={onKeyDown}
			/>
			<button type="button" id="groupNameConfirm" onClick={accept}>
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
