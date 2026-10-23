/**
 * `aside#previewPanel` (legacy index.html 797-809,
 * 1028-1113; app.js `renderPreview` toolbar state 1820-1828 and
 * `initPreviewPanel` 1890-1980).
 */

import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useT } from "../../i18n";
import { isMacPlatform } from "../../lib/format";
import { setUi, useAppStore } from "../../state/store";
import { IconButton, ResizeHandle } from "../../ui";
import {
	applyPreviewWidth,
	copyActivePreview,
	PREVIEW_DEFAULT,
	reloadActivePreview,
	restorePreviewWidth,
	setPreviewOpen,
	togglePreviewRendered,
	togglePreviewWrap,
} from "./actions";
import { ChangesView } from "./ChangesView";
import { isMarkdownPath } from "./highlight";
import { PreviewBody, PreviewPath, useActiveTab } from "./PreviewBody";
import { PreviewTabs } from "./PreviewTabs";
import { clearSideAnswers } from "./side-answers";

function PreviewTools() {
	const t = useT();
	const tab = useActiveTab();
	const wrap = useAppStore((state) => state.preview.wrap);
	const file = tab?.kind === "file" ? tab.file : undefined;
	const text = file?.kind === "text";
	const markdown = text && isMarkdownPath(file.path);
	const isFile = tab?.kind === "file";
	const rendered = tab?.kind === "file" && tab.rendered;
	return (
		<div className="preview-tools">
			<IconButton
				id="previewMode"
				icon="eye"
				iconSize="sm"
				aria-pressed={rendered}
				title={t("renderedPreview")}
				aria-label={t("renderedPreview")}
				hidden={!markdown}
				onClick={togglePreviewRendered}
			/>
			<IconButton
				id="previewWrap"
				icon="wrap"
				iconSize="sm"
				aria-pressed={wrap}
				title={t("wrapLines")}
				aria-label={t("wrapLines")}
				hidden={!text || Boolean(markdown && rendered)}
				// Legacy toggled `.code-view.wrap` in the click handler itself; callers read it right after.
				onClick={() => flushSync(togglePreviewWrap)}
			/>
			<IconButton
				id="previewReload"
				icon="loop"
				iconSize="sm"
				title={t("reloadFile")}
				aria-label={t("reloadFile")}
				hidden={!isFile}
				onClick={reloadActivePreview}
			/>
			<IconButton
				id="previewCopy"
				icon="copy"
				iconSize="sm"
				title={t("copyFile")}
				aria-label={t("copyFile")}
				hidden={!text}
				onClick={copyActivePreview}
			/>
			<IconButton
				id="previewClearSideAnswers"
				icon="trash"
				iconSize="sm"
				title={t("btwClear")}
				aria-label={t("btwClearHint")}
				hidden={tab?.kind !== "btw"}
				onClick={() => void clearSideAnswers()}
			/>
		</div>
	);
}

export function PreviewPanel({ embedded = false }: { readonly embedded?: boolean }) {
	const t = useT();
	const open = useAppStore((state) => state.preview.open);
	const changes = useAppStore((state) => state.preview.mode === "changes");
	const active = useActiveTab();
	/* With no file open the tab strip and path toolbar would be empty bars above the empty state. */
	const hasTab = Boolean(active);
	const panelRef = useRef<HTMLElement>(null);
	// The panel names what it is showing: a file, a diff, or a side question.
	const title = active?.kind === "btw" ? t("rightBtw") : t("filePreview");

	// Before the first paint: restoring the width here avoids a jump from the default.
	useLayoutEffect(() => {
		if (!embedded) restorePreviewWidth();
	}, [embedded]);

	const panelWidth = () => panelRef.current?.getBoundingClientRect().width ?? PREVIEW_DEFAULT;

	return (
		<aside className="preview-panel" id="previewPanel" ref={panelRef} title={title} aria-label={title} hidden={!open}>
			<ResizeHandle
				bare
				className="preview-resizer"
				id="previewResizer"
				direction={-1}
				getSize={panelWidth}
				onResize={(width) => applyPreviewWidth(width, false)}
				onCommit={(width) => applyPreviewWidth(width)}
				onReset={() => applyPreviewWidth(PREVIEW_DEFAULT)}
				onDraggingChange={(resizing) => setUi({ resizing })}
				hidden={embedded}
			/>
			<ChangesView hidden={!open || !changes} embedded={embedded} />
			<div className="preview-tabs-row" hidden={changes || (embedded && !hasTab)}>
				<PreviewTabs />
				<IconButton
					id="previewClose"
					icon="panelRight"
					title={`${t("closePreview")} ${isMacPlatform() ? "⇧⌘B" : "Ctrl+Shift+B"}`}
					aria-label="收起文件预览"
					onClick={() => setPreviewOpen(false)}
					hidden={embedded}
				/>
			</div>
			<div className="preview-toolbar" hidden={changes || !hasTab}>
				<PreviewPath />
				<PreviewTools />
			</div>
			<PreviewBody hidden={changes} />
		</aside>
	);
}
