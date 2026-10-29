/**
 * `.notice-row`: output a slash command published through `ui.notify`.
 *
 * A command's answer is not a turn: it never enters the session file and the
 * model never sees it. It therefore lives for this page load only and can be
 * dismissed. Markdown notices (`/btw` answers) render like message text;
 * everything else is preformatted, so alignment and indentation survive.
 *
 * A long plain warning or error (an MCP server's startup stderr, a provider
 * error body) starts folded to its first line, the headline that says what
 * failed; the rest is one click away. Info notices are command answers the
 * user asked for (`/status`), so they always show in full.
 */

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { renderMarkdown } from "../../lib/markdown";
import { copyText, dismissNotice } from "../../state/session";
import type { NoticeItem } from "../../state/types";
import { Button, IconButton, MarkdownView, Tooltip } from "../../ui";

/** Lines a warning may show unfolded; past this it opens collapsed. */
const COLLAPSIBLE_AFTER_LINES = 3;

/** The headline of a long plain warning/error, or `null` when it shows in full. */
function collapsedHeadline(notice: NoticeItem): string | null {
	if (notice.markdown || notice.level === "info") return null;
	const lines = notice.text.split("\n");
	if (lines.length <= COLLAPSIBLE_AFTER_LINES) return null;
	return lines[0] ?? "";
}

export function NoticeRow({ notice }: { readonly notice: NoticeItem }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const headline = useMemo(() => collapsedHeadline(notice), [notice]);
	const html = useMemo(
		() =>
			notice.markdown
				? renderMarkdown(notice.text, { code: t("code"), copy: t("copy"), table: t("markdownTable") })
				: "",
		[notice.markdown, notice.text, t],
	);
	const folded = headline !== null && !expanded;
	return (
		<section className="notice-row" data-level={notice.level} data-notice-id={notice.id}>
			<div className="notice-content">
				{notice.markdown ? (
					<MarkdownView
						html={html}
						className="notice-markdown"
						onCopyCode={(code) => copyText(code, null)}
						copiedLabel={t("copied")}
					/>
				) : (
					<p className="notice-text" data-collapsed={folded ? "true" : undefined}>
						{folded ? headline : notice.text}
					</p>
				)}
				{headline !== null ? (
					<Button
						className="notice-toggle"
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						{t(expanded ? "noticeCollapse" : "noticeExpand")}
					</Button>
				) : null}
			</div>
			<Tooltip content={t("noticeDismiss")}>
				<IconButton
					icon="closeSm"
					className="notice-dismiss"
					aria-label={t("noticeDismiss")}
					onClick={() => dismissNotice(notice.id)}
				/>
			</Tooltip>
		</section>
	);
}
