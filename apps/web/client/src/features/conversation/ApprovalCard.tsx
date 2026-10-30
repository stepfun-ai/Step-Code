import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import type { ApprovalRequest } from "../../state/types";
import { Icon } from "../../ui";
import { type ApprovalVerdict, decideApproval } from "./actions";

/**
 * The dialog body of a prompt forwarded from a subagent child, without the
 * internal tool-call id the kernel prefixes it with. Such a prompt is the only
 * one this page receives no structured tool input for.
 */
function forwardedDetail(message: string): string | undefined {
	const text = message.replace(/^Call: [^\n]*\n/u, "").trim();
	return text || undefined;
}

/** Render actual arguments, rather than the kernel's clipped diagnostic prompt. */
export function ApprovalCard({ approval }: { readonly approval: ApprovalRequest }) {
	const t = useT();
	const [decided, setDecided] = useState<ApprovalVerdict | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [truncated, setTruncated] = useState(false);
	const sending = useRef(false);
	const contentRef = useRef<HTMLPreElement>(null);
	const input = approval.input ?? {};
	const command = [input.command, input.cmd, input.script].find((value): value is string => typeof value === "string");
	const preview = approval.preview;
	const file = Boolean(preview?.path);
	const title =
		typeof input.justification === "string" && input.justification.trim()
			? input.justification
			: t(command !== undefined ? "approvalCommandTitle" : file ? "approvalFileTitle" : "approvalToolTitle", {
					tool: approval.toolName,
				});
	const content = [
		...(command !== undefined ? [command] : []),
		...(preview?.path ? [preview.path] : []),
		...(preview?.before !== undefined ? [`${t("approvalBefore")}\n${preview.before}`] : []),
		...(preview?.after !== undefined ? [`${t("approvalAfter")}\n${preview.after}`] : []),
		...(typeof input.then_run === "string" ? [`${t("approvalThenRun")}\n${input.then_run}`] : []),
		...(command === undefined && preview?.before === undefined && preview?.after === undefined
			? [forwardedDetail(approval.message) ?? `${approval.toolName}\n${JSON.stringify(input, null, 2)}`]
			: []),
	].join("\n\n");
	// Routine mutation boilerplate is replaced by the localized title; keep specific policy reasons.
	const reason =
		approval.reason && !approval.reason.endsWith("can modify the workspace or execute a command")
			? approval.reason
			: undefined;

	useLayoutEffect(() => {
		const element = contentRef.current;
		if (!element || expanded) return;
		const measure = () => setTruncated(content.length > 0 && element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [expanded, content]);

	const decide = async (verdict: ApprovalVerdict) => {
		if (sending.current) return;
		sending.current = true;
		setBusy(true);
		if (await decideApproval(approval.id, verdict)) setDecided(verdict);
		else {
			sending.current = false;
			setBusy(false);
		}
	};

	return (
		<div className="approval" data-approval-id={approval.id} aria-busy={busy}>
			<div className="approval-heading">
				<Icon name={file ? "file" : command !== undefined ? "terminal" : "shield"} />
				<span>{t(file ? "approvalFiles" : command !== undefined ? "approvalTerminal" : "approvalTool")}</span>
				{decided !== null && (
					<span className="approval-outcome">{t(decided === "deny" ? "denied" : "approved")}</span>
				)}
			</div>
			<strong className="approval-title">{title}</strong>
			{reason && <p className="approval-reason">{reason}</p>}
			<pre
				ref={contentRef}
				className={cx("approval-content", expanded && "expanded")}
				id={`approval-content-${approval.id}`}
			>
				{content}
			</pre>
			<div className="approval-expand-row" hidden={!truncated && !expanded}>
				<button
					type="button"
					className="approval-expand"
					aria-expanded={expanded}
					aria-controls={`approval-content-${approval.id}`}
					onClick={() => setExpanded((value) => !value)}
				>
					{t(expanded ? "approvalCollapse" : "approvalExpand")}
				</button>
			</div>
			<div className="approval-actions" hidden={decided !== null}>
				<button data-verdict="deny" type="button" disabled={busy} onClick={() => void decide("deny")}>
					{t("deny")}
				</button>
				<button
					className="approve"
					data-verdict="approve_for_session"
					type="button"
					disabled={busy}
					onClick={() => void decide("approve_for_session")}
				>
					{t("approveSession")}
				</button>
			</div>
		</div>
	);
}
