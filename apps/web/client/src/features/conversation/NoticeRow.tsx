/**
 * `.notice-row`: output a slash command published through `ui.notify`.
 *
 * A command's answer is not a turn: it never enters the session file and the
 * model never sees it. It therefore lives for this page load only and can be
 * dismissed. Markdown notices (`/btw` answers) render like message text;
 * everything else is preformatted, so alignment and indentation survive.
 */

import { useMemo } from "react";
import { useT } from "../../i18n";
import { renderMarkdown } from "../../lib/markdown";
import { copyText, dismissNotice } from "../../state/session";
import type { NoticeItem } from "../../state/types";
import { IconButton, MarkdownView, Tooltip } from "../../ui";

export function NoticeRow({ notice }: { readonly notice: NoticeItem }) {
	const t = useT();
	const html = useMemo(
		() =>
			notice.markdown
				? renderMarkdown(notice.text, { code: t("code"), copy: t("copy"), table: t("markdownTable") })
				: "",
		[notice.markdown, notice.text, t],
	);
	return (
		<section className="notice-row" data-level={notice.level} data-notice-id={notice.id}>
			<div className="notice-content">
				{notice.markdown ? (
					<MarkdownView html={html} className="notice-markdown" onCopyCode={(code) => void copyText(code)} />
				) : (
					<p className="notice-text">{notice.text}</p>
				)}
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
