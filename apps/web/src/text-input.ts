import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@step-harness/coding-agent";

type Input = NonNullable<ExtensionUIContext["input"]>;

/**
 * A text prompt a kernel callback is waiting on.
 *
 * The title and placeholder travel verbatim: the kernel owns the wording of its
 * own dialogs. The host only carries the question out and the answer in.
 */
export interface TextInputRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly placeholder?: string;
}

export type TextInputEvent =
	| { type: "text_input_required"; input: TextInputRequest }
	| { type: "text_input_resolved"; id: string };

interface PendingInput {
	readonly request: TextInputRequest;
	readonly finish: (value: string | undefined) => void;
}

/**
 * Transport for the kernel's `ui.input` dialogs.
 *
 * Without it the Web host answered `undefined`, which the kernel reads as "the
 * user cancelled" — so a command stopped halfway with no message (the
 * `/feedback` wizard asked for a category and then vanished). Asking the user
 * is what makes an input-taking command complete on this host at all.
 *
 * `undefined` means dismissed; an empty string is a real, submitted answer.
 */
export class TextInputBroker {
	private readonly pending = new Map<string, PendingInput>();
	private readonly sessionId: () => string;
	private readonly emit: (event: TextInputEvent) => void;

	constructor(sessionId: () => string, emit: (event: TextInputEvent) => void) {
		this.sessionId = sessionId;
		this.emit = emit;
	}

	ask(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		const request: TextInputRequest = {
			id: randomUUID(),
			sessionId: this.sessionId(),
			title,
			...(placeholder === undefined ? {} : { placeholder }),
		};
		return new Promise((resolve) => {
			const onAbort = () => finish(undefined);
			// An input settles at most once: answered, dismissed, or abandoned by an
			// aborted turn.
			const finish = (value: string | undefined) => {
				if (!this.pending.delete(request.id)) return;
				signal?.removeEventListener("abort", onAbort);
				this.emit({ type: "text_input_resolved", id: request.id });
				resolve(value);
			};
			this.pending.set(request.id, { request, finish });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit({ type: "text_input_required", input: request });
		});
	}

	/** Inputs still waiting for an answer, oldest first, so a reloaded page can show them again. */
	pendingRequests(): TextInputRequest[] {
		return [...this.pending.values()].map(({ request }) => request);
	}

	/**
	 * Answer a pending input. Returns false for an unknown id (a stale page whose
	 * dialog was already answered, or a session that was replaced).
	 */
	respond(id: string, value: string | undefined): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		pending.finish(value);
		return true;
	}

	clear(): void {
		for (const { finish } of [...this.pending.values()]) finish(undefined);
	}
}

/** `input` bound to this broker, for `webUiContext`. */
export function textInput(broker: TextInputBroker): Input {
	return (title, placeholder, opts) => broker.ask(title, placeholder, opts?.signal);
}
