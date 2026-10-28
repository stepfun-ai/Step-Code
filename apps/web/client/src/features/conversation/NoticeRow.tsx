/**
 * `.notice-row`: output a slash command published through `ui.notify`.
 *
 * A command's answer is not a turn: it never enters the session file and the
 * model never sees it. It therefore lives for this page load only and can be
 * dismissed. Markdown notices (`/btw` answers) render like message text;
 * everything else is preformatted, so alignment and indentation survive.
 */

import { useMarkdownLabels, useT } from "../../i18n";
import { copyText, dismissNotice } from "../../state/session";
import type { NoticeItem } from "../../state/types";
import { IconButton, MarkdownView, Tooltip } from "../../ui";

const copyCode = (code: string) => copyText(code, null);

export function NoticeRow({ notice }: { readonly notice: NoticeItem }) {
	const t = useT();
	const labels = useMarkdownLabels();
	return (
		<section className="notice-row" data-level={notice.level} data-notice-id={notice.id}>
			<div className="notice-content">
				{notice.markdown ? (
					<MarkdownView
						source={notice.text}
						labels={labels}
						className="notice-markdown"
						onCopyCode={copyCode}
						copiedLabel={t("copied")}
					/>
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
