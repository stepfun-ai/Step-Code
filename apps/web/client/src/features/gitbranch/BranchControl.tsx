import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { activeCwd } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import { Icon, Popover, SearchInput } from "../../ui";
import { branchFailureMessage, type GitBranchSnapshot, loadBranches, switchToBranch } from "./actions";
import { CreateBranchDialog } from "./CreateBranchDialog";

/**
 * `#branchControl`: the branch switcher beside the workspace pill, just above
 * the composer card. One pill names the current branch; its popover lists the
 * local branches with the current one checked, and pins "Create and checkout
 * new branch…" to its bottom so a long list never scrolls the action away. A
 * switch that git refuses (uncommitted work it would overwrite) shows the
 * reason and leaves the list open, so the user can pick another branch without
 * reopening.
 *
 * Shown only while the composer is a draft, alongside the workspace pill: both
 * choose where the next conversation starts. An open session is pinned to the
 * folder and branch it was created in, so neither picker applies to it.
 * Hidden too when the folder is not inside a git work tree.
 *
 * Placement is the shared `Popover`'s: anchored to the pill and flipped above
 * it when the composer leaves no room below.
 */
export function BranchControl() {
	const t = useT();
	const [snapshot, setSnapshot] = useState<GitBranchSnapshot | null>(null);
	const [pending, setPending] = useState(false);
	/** A refused switch, shown in the popover the user picked from. */
	const [failure, setFailure] = useState<string | null>(null);
	/** A refused create, shown in the dialog that is still open. */
	const [createError, setCreateError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const cwd = useAppStore(activeCwd);
	const draft = useAppStore((state) => !state.current);
	const open = useAppStore((state) => state.ui.branchPopoverOpen);
	const creating = useAppStore((state) => state.ui.branchCreateOpen);
	/** Sequence of the latest git read; an older answer is dropped. */
	const latest = useRef(0);

	const reload = useCallback(async (folder: string) => {
		// Reads race: a large repository answers seconds after a small one, so the
		// folder picked first could overwrite the folder picked last. Only the
		// latest request may publish.
		const ticket = ++latest.current;
		let next: GitBranchSnapshot;
		try {
			next = await loadBranches(folder);
		} catch {
			// A branch pill is secondary to the composer: an unreadable repository
			// hides it instead of raising a banner on every turn.
			next = { state: { repository: false }, branches: [] };
		}
		if (ticket === latest.current) setSnapshot(next);
	}, []);

	useEffect(() => {
		setFailure(null);
		// An open session does not show the pill, so it needs no git call either.
		if (!cwd || !draft) {
			// Also void any read still in flight for the previous folder.
			latest.current += 1;
			setSnapshot(null);
			return;
		}
		// The previous folder's branches must not show under the new folder name
		// while this read is in flight.
		setSnapshot(null);
		void reload(cwd);
	}, [cwd, draft, reload]);

	// Re-read when the popover opens: a branch changed in a terminal shows up
	// without a reload, and the list is never a stale snapshot. The panel is
	// rendered only while open, so its search field starts empty each time;
	// the filter must start empty with it.
	useEffect(() => {
		if (!open) return;
		setSearch("");
		if (cwd) void reload(cwd);
	}, [open, cwd, reload]);

	// A reopened dialog starts without the last attempt's error.
	useEffect(() => {
		if (creating) setCreateError(null);
	}, [creating]);

	const state = snapshot?.state;
	const branches = snapshot?.branches ?? [];
	const visible = draft && Boolean(state?.repository);
	const current = state?.branch ?? "";
	const label = state?.detached ? t("branchDetached") : current || t("branchSwitcherLabel");
	const dirty = state?.dirtyFiles ?? 0;
	const query = search.trim().toLocaleLowerCase();
	const filtered = query ? branches.filter((branch) => branch.name.toLocaleLowerCase().includes(query)) : branches;

	const close = () => setUi({ branchPopoverOpen: false });

	const pick = async (name: string, create = false) => {
		if (!cwd || pending) return;
		setPending(true);
		const report = create ? setCreateError : setFailure;
		report(null);
		try {
			await switchToBranch(cwd, name, create);
			// The mutating call already refreshed the branch name; the list order
			// changed with the switch, so read it again.
			await reload(cwd);
			close();
			setUi({ branchCreateOpen: false });
		} catch (error) {
			report(branchFailureMessage(error));
		} finally {
			setPending(false);
		}
	};

	const panel = (
		<>
			<SearchInput
				id="branchSearch"
				bare
				wrapperClassName="branch-search"
				placeholder={t("branchSearchPlaceholder")}
				defaultValue=""
				// Tests assign `value` and dispatch a non-bubbling `input`; capture
				// catches it, and the filter runs on every keystroke.
				onInputCapture={(event) => setSearch(event.currentTarget.value)}
			/>
			<div className="branch-popover-divider" />
			{/* Only this section scrolls, so the create action below stays reachable. */}
			<div className="branch-popover-scroll">
				<div className="branch-popover-title">{t("branchListTitle")}</div>
				<div id="branchList" role="listbox" aria-label={t("branchListTitle")}>
					{filtered.map((branch) => (
						<BranchRow
							key={branch.name}
							name={branch.name}
							selected={branch.name === current}
							detail={branch.name === current && dirty ? t("branchUncommitted", { count: dirty }) : undefined}
							disabled={pending}
							onPick={() => void pick(branch.name)}
						/>
					))}
					{filtered.length ? null : (
						<div className="branch-empty">{branches.length ? t("branchNoMatch") : t("branchNone")}</div>
					)}
				</div>
			</div>
			{failure ? <div className="branch-failure">{failure}</div> : null}
			<div className="branch-popover-divider" />
			<button
				className="branch-create-button"
				id="branchCreateButton"
				type="button"
				disabled={pending}
				onClick={() => {
					close();
					setFailure(null);
					setUi({ branchCreateOpen: true });
				}}
			>
				<Icon name="plus" size="sm" />
				<span>{t("branchCreateAction")}</span>
			</button>
		</>
	);

	return (
		<>
			<div className="branch-control" id="branchControl" hidden={!visible}>
				<Popover
					bare
					id="branchPopover"
					className="branch-popover"
					open={open}
					onClose={close}
					dismissOn="click"
					closeOnEscape={false}
					content={panel}
				>
					<button
						id="branchButton"
						className="branch-pill"
						type="button"
						aria-haspopup="listbox"
						aria-expanded={open}
						aria-label={t("branchSwitcherAria", { name: label })}
						title={label}
						onClick={() => {
							setFailure(null);
							setUi({ branchPopoverOpen: !open });
						}}
					>
						<Icon name="fork" size="sm" className="branch-icon" />
						<span id="branchButtonName">{label}</span>
						<Icon name="chevronDown" size="2xs" className="chevron" />
					</button>
				</Popover>
			</div>
			<CreateBranchDialog
				open={creating}
				pending={pending}
				error={createError}
				currentBranch={label}
				onClose={() => setUi({ branchCreateOpen: false })}
				onSubmit={(name) => void pick(name, true)}
			/>
		</>
	);
}

/** One branch: name, an optional detail line (the current branch's dirty count), a check when current. */
function BranchRow({
	name,
	selected,
	detail,
	disabled,
	onPick,
}: {
	readonly name: string;
	readonly selected: boolean;
	readonly detail?: string;
	readonly disabled: boolean;
	readonly onPick: () => void;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			disabled={disabled}
			className={`branch-item${selected ? " selected" : ""}`}
			title={name}
			onClick={onPick}
		>
			<Icon name="fork" size="sm" className="branch-icon" />
			<span className="branch-item-text">
				<span className="branch-item-name">{name}</span>
				{detail ? <span className="branch-item-detail">{detail}</span> : null}
			</span>
			{selected ? <Icon name="check" size="sm" className="branch-check" /> : null}
		</button>
	);
}
