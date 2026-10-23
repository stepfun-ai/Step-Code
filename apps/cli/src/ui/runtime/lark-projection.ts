import type { LarkApi } from "@step-harness/lark-adapter";

/** Ephemeral rendering projection; never reads history or owns session messages. */
export class LarkProjection {
	private readonly api: LarkApi;
	private readonly chatId: string;
	private readonly onError: () => void;
	private cardId: string | undefined;
	private text = "";
	private prompt = "";
	private status = "thinking";
	private settings = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writes = Promise.resolve();
	private generation = 0;
	private closed = false;

	constructor(api: LarkApi, chatId: string, onError: () => void) {
		this.api = api;
		this.chatId = chatId;
		this.onError = onError;
	}

	begin(prompt: string): void {
		this.generation++;
		this.cardId = undefined;
		this.prompt = prompt.slice(0, 4000);
		this.text = "";
		this.status = "thinking";
		this.flush();
	}

	setSettings(model: string | undefined, effort: string | undefined): void {
		const settings = `Model: ${model ?? "no-model"} | Effort: ${effort ?? "off"}`;
		if (settings === this.settings) return;
		this.settings = settings;
		if (this.generation > 0) this.flush();
	}

	update(text: string): void {
		this.text = text.slice(-20_000);
		this.schedule();
	}
	working(toolName: string): void {
		this.status = `working: ${toolName}`;
		this.schedule();
	}
	done(): void {
		this.status = "done";
		this.flush();
	}

	private schedule(): void {
		if (this.closed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, 2000);
	}

	private flush(): void {
		if (this.closed) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const generation = this.generation;
		const card = {
			config: { wide_screen_mode: true, enable_forward: false },
			header: { title: { tag: "plain_text", content: `StepCode: ${this.status}` } },
			elements: [
				{ tag: "div", text: { tag: "plain_text", content: this.settings } },
				{ tag: "div", text: { tag: "plain_text", content: this.prompt } },
				{ tag: "markdown", content: this.text || "Waiting for agent output." },
			],
		};
		this.writes = this.writes
			.then(async () => {
				if (this.closed || generation !== this.generation) return;
				if (this.cardId) await this.api.updateCard(this.cardId, card);
				else {
					const id = await this.api.sendCard(this.chatId, card);
					if (!this.closed && generation === this.generation) {
						this.cardId = id;
					}
				}
			})
			.catch(() => {
				if (!this.closed && generation === this.generation) this.onError();
			});
	}

	close(): void {
		this.closed = true;
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
	}
}
