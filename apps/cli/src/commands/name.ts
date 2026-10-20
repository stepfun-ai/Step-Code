import {
	type AgentSession,
	type RegenerateSessionTitleResult,
	regenerateSessionTitle,
} from "@step-harness/coding-agent";

export type NameRequest = { kind: "set"; name: string } | { kind: "regenerate" };
export type NameResult =
	| RegenerateSessionTitleResult
	| { status: "set"; requestedName: string; name: string | undefined };

/** Command semantics only: the caller owns progress presentation and cancellation. */
export const nameCommand = {
	name: "name",
	description: "Set session display name, or regenerate it from the conversation",
	argumentHint: "[name]",
	parse(text: string): NameRequest {
		const name = text.replace(/^\/name\s*/, "").trim();
		return name ? { kind: "set", name } : { kind: "regenerate" };
	},
	async run(
		session: Pick<AgentSession, "model" | "modelRuntime" | "sessionManager" | "setSessionName">,
		request: NameRequest,
		signal: AbortSignal,
	): Promise<NameResult> {
		if (signal.aborted) return { status: "superseded" };
		if (request.kind === "regenerate") return regenerateSessionTitle(session, signal);
		session.setSessionName(request.name);
		return { status: "set", requestedName: request.name, name: session.sessionManager.getSessionName() };
	},
};
