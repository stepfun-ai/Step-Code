/**
 * `#previewBody` and `#previewPath` (legacy `renderPreview`, `previewMessage`,
 * `buildCodeView`; app.js 1771-1873).
 */

import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { useT } from "../../i18n";
import { localFileApi, workspaceApi } from "../../lib/api";
import { basename, cx, formatBytes } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { copyText } from "../../state/session";
import { type FilePreviewTab, type PreviewTab, type SideAnswerTab, useAppStore } from "../../state/store";
import { Icon, MarkdownView, Spinner } from "../../ui";
import { openFileReference } from "./actions";
import { codeViewHtml, isMarkdownPath, PREVIEW_LINE_LIMIT } from "./highlight";
import { sideAnswerHtml } from "./side-answer-html";

/** The tab the preview shows, or undefined when there are no tabs. */
export function useActiveTab(): PreviewTab | undefined {
	return useAppStore((state) => state.preview.tabs[state.preview.active]);
}

/** Full on-disk path of a file tab, in the workspace's own separator style. */
function fullPath(tab: FilePreviewTab): string {
	// Outside-workspace tabs carry their own absolute path already.
	if (tab.scope === "local") return tab.path;
	// Server paths are relative with "/"; show them in the workspace's own style.
	const separator = tab.cwd.includes("\\") && !tab.cwd.includes("/") ? "\\" : "/";
	return `${tab.cwd.replace(/[\\/]+$/, "")}${separator}${tab.path.split("/").join(separator)}`;
}

export function PreviewPath() {
	const tab = useActiveTab();
	if (!tab) return <div className="preview-path" id="previewPath" />;
	if (tab.kind === "btw") return <SideAnswerPath question={tab.question} model={tab.model} />;
	const full = fullPath(tab);
	const name = basename(tab.path);
	const directory = full.slice(0, -name.length);
	return (
		<div className="preview-path" id="previewPath" title={full}>
			<span>
				<bdi>{directory}</bdi>
			</span>
			<strong>{name}</strong>
			{tab.file ? <small>{formatBytes(tab.file.size)}</small> : null}
		</div>
	);
}

/**
 * The toolbar line of a side answer. The question itself is the body's heading,
 * so this only names the surface and the model that answered.
 */
function SideAnswerPath({ question, model }: { readonly question: string; readonly model?: string }) {
	const t = useT();
	return (
		<div className="preview-path" id="previewPath" title={question}>
			<strong>{t("rightBtw")}</strong>
			{model ? <small>{model}</small> : null}
		</div>
	);
}

function PreviewMessage({ children }: { readonly children: ReactNode }) {
	return <div className="preview-message">{children}</div>;
}

function CodeView({ content, path }: { readonly content: string; readonly path: string }) {
	const t = useT();
	const wrap = useAppStore((state) => state.preview.wrap);
	const notice = t("linesTruncated", { count: PREVIEW_LINE_LIMIT });
	const view = useMemo(() => codeViewHtml(content, path, notice), [content, path, notice]);
	return (
		<div
			className={cx("code-view", wrap && "wrap")}
			style={{ "--line-digits": String(view.digits) } as CSSProperties}
			// Escaped by highlightLines / codeViewHtml; one string keeps 10 000 lines cheap.
			// biome-ignore lint/security/noDangerouslySetInnerHtml: legacy .code-line/.tok-* markup, built from escaped text only.
			dangerouslySetInnerHTML={{ __html: view.html }}
		/>
	);
}

function SideAnswer({ tab }: { readonly tab: SideAnswerTab }) {
	const t = useT();
	const html = useMemo(
		() => sideAnswerHtml(tab.text, { code: t("code"), copy: t("copy"), table: t("markdownTable") }),
		[tab.text, t],
	);
	if (tab.pending) {
		return (
			<div className="side-answer" data-pending="true">
				<p className="side-answer-question">{tab.question}</p>
				<output className="side-answer-waiting" aria-live="polite">
					<Spinner />
					<span>{t("btwWaiting")}</span>
				</output>
			</div>
		);
	}
	return (
		<div className="side-answer" data-unavailable={tab.unavailable || undefined}>
			<p className="side-answer-question">{tab.question}</p>
			<MarkdownView
				className="side-answer-body message-body"
				html={html}
				onCopyCode={(code) => void copyText(code)}
			/>
			<p className="side-answer-note">{t("btwNotSaved")}</p>
		</div>
	);
}

function PreviewContent({ tab }: { readonly tab: PreviewTab }) {
	const t = useT();
	if (tab.kind === "btw") return <SideAnswer tab={tab} />;
	const file = tab.file;
	if (tab.loading) return <PreviewMessage>{t("loadingFile")}</PreviewMessage>;
	if (tab.error) return <PreviewMessage>{tab.error}</PreviewMessage>;
	if (!file) return null;
	if (file.kind === "image")
		return (
			<img
				className="preview-image"
				alt={basename(file.path)}
				src={
					tab.scope === "local"
						? localFileApi("/raw", tab.path)
						: workspaceApi(tab.cwd, "/raw", { path: tab.path })
				}
			/>
		);
	if (file.kind !== "text")
		return (
			<PreviewMessage>
				{file.kind === "binary" ? t("binaryFile") : t("fileTooLarge", { size: formatBytes(file.size) })}
			</PreviewMessage>
		);
	if (tab.rendered && isMarkdownPath(file.path))
		return (
			<MarkdownView
				className="preview-markdown message-body"
				html={renderMarkdown(
					file.content,
					{ code: t("code"), copy: t("copy"), table: t("markdownTable") },
					{ localFiles: true },
				)}
				onCopyCode={(code) => void copyText(code)}
				onFileReference={(path) => void openFileReference(tab.cwd, path, tab.path)}
			/>
		);
	return <CodeView content={file.content} path={file.path} />;
}

export function PreviewBody({ hidden = false }: { readonly hidden?: boolean }) {
	const t = useT();
	const tabs = useAppStore((state) => state.preview.tabs);
	const active = useAppStore((state) => state.preview.active);
	const tab = tabs[active];
	const bodyRef = useRef<HTMLDivElement>(null);

	// Legacy renderPreview scrolled back to the top on every redraw of the tabs or the body.
	useLayoutEffect(() => {
		if (!tabs[active] || !bodyRef.current) return;
		bodyRef.current.scrollTop = 0;
	}, [tabs, active]);

	return (
		<div className="preview-body" id="previewBody" ref={bodyRef} hidden={hidden}>
			{tab ? (
				<PreviewContent tab={tab} />
			) : (
				<div className="preview-message changes-empty">
					<Icon name="fileText" />
					{t("rightNoFiles")}
				</div>
			)}
		</div>
	);
}
