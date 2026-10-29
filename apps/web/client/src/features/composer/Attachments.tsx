/** Staged attachments: `#attachmentList` (legacy app.js 2919-2985). */

import { useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import { setUi, useAppStore } from "../../state/store";
import type { Attachment } from "../../state/types";
import { IconButton, Tooltip } from "../../ui";
import { removeAttachment } from "./actions";

/**
 * Attachments carry no id (the API body is exactly the legacy shape), but the
 * store replaces the list without copying its entries, so each object is a
 * stable identity for the chip's React key.
 */
const chipKeys = new WeakMap<Attachment, number>();
let nextChipKey = 0;
function chipKey(attachment: Attachment): number {
	let key = chipKeys.get(attachment);
	if (key === undefined) {
		nextChipKey += 1;
		key = nextChipKey;
		chipKeys.set(attachment, key);
	}
	return key;
}

/** An image attachment's thumbnail; clicking it opens `#imagePreview`. */
function ImageThumb({ attachment }: { readonly attachment: Attachment }) {
	const t = useT();
	const src = `data:${attachment.mimeType};base64,${attachment.data}`;
	const label = t("previewImageNamed", { name: attachment.name });
	return (
		<Tooltip content={attachment.name}>
			<button
				type="button"
				className="attachment-thumb"
				aria-label={label}
				onClick={() => setUi({ imagePreview: { src, name: attachment.name } })}
			>
				<img src={src} alt="" />
			</button>
		</Tooltip>
	);
}

/** `#attachmentList`: shared chip presentation for the main input and explicitly owned rewrite images. */
export function AttachmentList({
	attachments: ownedAttachments,
	onRemove,
}: {
	readonly attachments?: readonly Attachment[];
	readonly onRemove?: (index: number) => void;
} = {}) {
	const t = useT();
	const mainAttachments = useAppStore((state) => state.attachments);
	const attachments = ownedAttachments ?? mainAttachments;
	const [hoveredName, setHoveredName] = useState<Attachment | null>(null);
	return (
		<div
			className="attachment-list"
			id={ownedAttachments ? undefined : "attachmentList"}
			hidden={!attachments.length}
		>
			{attachments.map((attachment, index) => (
				<span
					className={cx("attachment-chip", attachment.kind === "image" && "attachment-chip--image")}
					key={chipKey(attachment)}
				>
					{attachment.kind === "image" ? (
						<ImageThumb attachment={attachment} />
					) : (
						<Tooltip content={hoveredName === attachment ? attachment.name : null}>
							<span
								onPointerEnter={(event) => {
									const label = event.currentTarget;
									setHoveredName(label.scrollWidth > label.clientWidth ? attachment : null);
								}}
								onPointerLeave={() => setHoveredName(null)}
							>
								{attachment.name}
							</span>
						</Tooltip>
					)}
					<Tooltip content={t("removeAttachment")}>
						<IconButton
							className="attachment-remove"
							icon="close-sm"
							iconSize="xs"
							aria-label={t("removeAttachment")}
							onClick={() => (onRemove ?? removeAttachment)(index)}
						/>
					</Tooltip>
				</span>
			))}
		</div>
	);
}
