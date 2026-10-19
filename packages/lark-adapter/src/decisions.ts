import { randomUUID } from "node:crypto";

/** Ephemeral card tokens. Local completion and teardown revoke them before any late click. */
export class LarkDecisions {
	private readonly pending = new Map<
		string,
		{ chatId: string; options: readonly string[]; resolve: (value: string) => void }
	>();
	private closed = false;

	open(chatId: string, options: readonly string[], resolve: (value: string) => void): string {
		if (this.closed) throw new Error("Lark decisions closed");
		const token = randomUUID();
		this.pending.set(token, { chatId, options: [...options], resolve });
		return token;
	}

	choose(token: string, chatId: string, value: string): boolean {
		const request = this.pending.get(token);
		if (!request || request.chatId !== chatId || !request.options.includes(value)) return false;
		this.pending.delete(token);
		request.resolve(value);
		return true;
	}

	dismiss(token: string): void {
		this.pending.delete(token);
	}
	close(): void {
		this.closed = true;
		this.pending.clear();
	}
}
