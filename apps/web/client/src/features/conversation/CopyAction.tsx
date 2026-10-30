import { useT } from "../../i18n";
import { copyText } from "../../state/session";
import { Icon, useCopiedFlag } from "../../ui";

/** A message's copy button; it confirms in place with a check instead of a toast. */
export function CopyAction({
	value,
	className = "message-action",
}: {
	readonly value: string;
	readonly className?: string;
}) {
	const t = useT();
	const [copied, flash] = useCopiedFlag();
	const copy = async () => {
		if (await copyText(value, null)) flash();
	};
	return (
		<button
			type="button"
			className={className}
			title={t("copy")}
			aria-label={t("copy")}
			data-copied={copied || undefined}
			onClick={() => void copy()}
		>
			<Icon name={copied ? "check" : "copy"} size="xs" />
		</button>
	);
}
