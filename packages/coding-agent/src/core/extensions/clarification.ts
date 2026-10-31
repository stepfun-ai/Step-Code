/** Structured clarification capability for hosts that cannot render TUI components. */
export interface ClarificationQuestion {
	id: string;
	label: string;
	question: string;
	reason?: string;
	options: { label: string; value: string; description?: string }[];
	allowFreeform: boolean;
	/** Presentation metadata for a plan review; the complete proposal remains in reason. */
	intent?: { kind: "plan_review"; planFilePath: string; planHash: string };
}

export interface ClarificationAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	skipped?: boolean;
}

export interface ClarificationResult {
	answers: ClarificationAnswer[];
	cancelled: boolean;
}
