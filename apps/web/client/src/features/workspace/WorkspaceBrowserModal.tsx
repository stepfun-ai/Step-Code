import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { getState, useAppStore } from "../../state/store";
import { Button, EmptyState, Icon, IconButton, LEGACY_ICONS, Modal, SearchInput } from "../../ui";
import { closeWorkspaceBrowser, confirmWorkspaceBrowser, loadWorkspaceDirectory } from "./actions";

/**
 * `#workspaceBrowserModal`, the in-page folder browser (legacy index.html
 * 1203-1279, `renderWorkspaceDirectoryList` 1140-1162, wiring 3466-3494).
 *
 * Escape is handled by the shell's central Escape chain, so the modal does not
 * listen for it itself. The path input and the directory search stay
 * uncontrolled: every loaded listing writes its path into the input and clears
 * the search, exactly as the legacy `loadWorkspaceDirectory` did.
 */
export function WorkspaceBrowserModal() {
	const t = useT();
	const open = useAppStore((state) => state.ui.workspaceBrowserOpen);
	const purpose = useAppStore((state) => state.ui.workspaceBrowserPurpose);
	const browser = useAppStore((state) => state.workspaceBrowser);
	const [query, setQuery] = useState("");
	const pathRef = useRef<HTMLInputElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const ime = useImeGuard();

	useLayoutEffect(() => {
		if (pathRef.current) pathRef.current.value = browser.path;
		if (searchRef.current) searchRef.current.value = "";
		setQuery("");
	}, [browser]);

	const normalized = query.trim().toLowerCase();
	const directories = browser.directories.filter(
		(entry) => !normalized || entry.name.toLowerCase().includes(normalized),
	);

	return (
		<Modal
			id="workspaceBrowserModal"
			overlayClassName="workspace-browser-overlay"
			className="workspace-browser-dialog"
			labelledBy="workspaceBrowserTitle"
			open={open}
			onClose={closeWorkspaceBrowser}
		>
			<header>
				<h2 id="workspaceBrowserTitle">{t(purpose === "resource" ? "migrationPickTarget" : "addWorkspace")}</h2>
				<IconButton
					id="workspaceBrowserClose"
					icon="close"
					iconSize="lg"
					title="关闭"
					aria-label="关闭"
					onClick={closeWorkspaceBrowser}
				/>
			</header>
			<div className="workspace-path-row">
				{/* The server computes the parent, so Windows drive paths work as well as POSIX ones. */}
				<IconButton
					id="workspaceParentButton"
					icon="up"
					title="上一级"
					aria-label="上一级"
					onClick={() => void loadWorkspaceDirectory(getState().workspaceBrowser.parent)}
				/>
				<input
					ref={pathRef}
					id="workspacePathInput"
					type="text"
					aria-label="绝对路径"
					defaultValue=""
					{...ime.handlers}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !ime.isComposing(event)) {
							event.preventDefault();
							void loadWorkspaceDirectory(event.currentTarget.value.trim());
						}
					}}
				/>
				<button
					id="workspacePathGo"
					type="button"
					onClick={() => void loadWorkspaceDirectory(pathRef.current?.value.trim() ?? "")}
				>
					{t("go")}
				</button>
			</div>
			<SearchInput
				bare
				wrapperClassName="workspace-directory-search"
				ref={searchRef}
				id="workspaceDirectorySearch"
				placeholder={t("searchInDirectory")}
				defaultValue=""
				onInputCapture={(event) => setQuery(event.currentTarget.value)}
			/>
			<div className="workspace-directory-list" id="workspaceDirectoryList">
				{directories.length ? (
					directories.map((directory) => (
						<button
							key={directory.path}
							type="button"
							className="workspace-directory-item"
							onClick={() => void loadWorkspaceDirectory(directory.path)}
						>
							<Icon {...LEGACY_ICONS.folder} />
							<span>{directory.name}</span>
						</button>
					))
				) : (
					<EmptyState>{t("emptyDirectory")}</EmptyState>
				)}
			</div>
			<footer>
				<span>{t("workspaceHelp")}</span>
				<div>
					<Button
						variant="secondary"
						className="secondary-action"
						id="workspaceBrowserCancel"
						onClick={closeWorkspaceBrowser}
					>
						{t("cancel")}
					</Button>
					<Button
						variant="primary"
						className="primary-action"
						id="workspaceBrowserConfirm"
						onClick={() => {
							const path = getState().workspaceBrowser.path;
							if (!path) return;
							void confirmWorkspaceBrowser(path);
						}}
					>
						{t(purpose === "resource" ? "migrationUseTarget" : "openFolder")}
					</Button>
				</div>
			</footer>
		</Modal>
	);
}
