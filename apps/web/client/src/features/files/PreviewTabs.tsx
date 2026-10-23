/**
 * `#previewTabs` (legacy `renderPreview` tab strip, app.js 1797-1814, and the
 * tab click / auxclick / keydown wiring, 1932-1954).
 */

import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { basename, cx } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Icon, LEGACY_ICONS } from "../../ui";
import { closePreviewTab, selectPreviewTab } from "./actions";

/** First line of a side question, short enough for a tab. */
function tabTitle(question: string): string {
	const line = question.replace(/\s+/gu, " ").trim();
	return line.length <= 28 ? line : `${line.slice(0, 27)}…`;
}

export function PreviewTabs() {
	const t = useT();
	const tabs = useAppStore((state) => state.preview.tabs);
	const active = useAppStore((state) => state.preview.active);
	const listRef = useRef<HTMLDivElement>(null);

	// Keep the active tab in view whenever the strip is redrawn.
	useLayoutEffect(() => {
		if (!tabs[active]) return;
		listRef.current?.querySelector(".preview-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [tabs, active]);

	const onClick = (event: MouseEvent<HTMLDivElement>, index: number) => {
		if (event.target instanceof Element && event.target.closest(".preview-tab-close")) closePreviewTab(index);
		else selectPreviewTab(index);
	};
	const onAuxClick = (event: MouseEvent<HTMLDivElement>, index: number) => {
		if (event.button === 1) closePreviewTab(index);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
		if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
		event.preventDefault();
		selectPreviewTab(index);
	};

	return (
		<div className="preview-tabs" id="previewTabs" role="tablist" ref={listRef}>
			{tabs.map((tab, index) => (
				<div
					// Tabs are identified by position in the legacy DOM (`data-index`); a file's
					// cwd + path + scope is unique, a side answer's id is.
					key={tab.kind === "file" ? `${tab.cwd}\u0000${tab.path}\u0000${tab.scope ?? ""}` : `btw:${tab.id}`}
					className={cx("preview-tab", index === active && "active")}
					role="tab"
					tabIndex={0}
					data-index={String(index)}
					title={tab.kind === "file" ? tab.path : tab.question}
					aria-selected={index === active}
					onClick={(event) => onClick(event, index)}
					onAuxClick={(event) => onAuxClick(event, index)}
					onKeyDown={(event) => onKeyDown(event, index)}
				>
					{tab.kind === "file" ? (
						<Icon {...LEGACY_ICONS.file} />
					) : (
						<Icon name={tab.pending ? "loaderCircle" : "question"} size="sm" />
					)}
					<span>{tab.kind === "file" ? basename(tab.path) : tabTitle(tab.question)}</span>
					<button className="preview-tab-close" type="button" title={t("closeTab")} aria-label={t("closeTab")}>
						<Icon name="close-sm" size="xs" />
					</button>
				</div>
			))}
		</div>
	);
}
