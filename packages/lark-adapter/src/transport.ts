import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { LarkInboundGate, type LarkMessage } from "./inbound.ts";
import { LARK_OPEN_HOSTS, type LarkCredentials } from "./registration.ts";

export interface LarkTransportOptions {
	credentials: LarkCredentials;
	botId: string;
	onMessage: (message: LarkMessage) => void;
	onCardAction: (action: { chatId: string; token: string; option: string }) => void;
	onState: (state: "connected" | "degraded") => void;
}

// SDK diagnostics can contain request credentials and must never reach the terminal.
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

/** Single-use socket; owns input routing only, never an agent or transcript. */
export class LarkTransport {
	private readonly gate: LarkInboundGate;
	private readonly socket: WSClient;
	private readonly dispatcher: EventDispatcher;
	private closed = false;
	private started = false;

	constructor(options: LarkTransportOptions) {
		this.gate = new LarkInboundGate(options.botId);
		this.dispatcher = new EventDispatcher({ logger: silentLogger, loggerLevel: LoggerLevel.error }).register({
			"im.message.receive_v1": (event) => {
				const result = this.gate.accept(event);
				if (result.action === "accept") options.onMessage(result.message);
				return {};
			},
			"card.action.trigger": (event: {
				context?: { open_chat_id?: unknown };
				action?: { value?: { token?: unknown; option?: unknown } };
			}) => {
				const chatId = event?.context?.open_chat_id;
				const value = event?.action?.value;
				if (
					!this.closed &&
					typeof chatId === "string" &&
					chatId &&
					chatId === this.gate.chatId &&
					typeof value?.token === "string" &&
					value.token &&
					typeof value.option === "string" &&
					value.option
				) {
					options.onCardAction({ chatId, token: value.token, option: value.option });
				}
				return {};
			},
		});
		this.socket = new WSClient({
			appId: options.credentials.appId,
			appSecret: options.credentials.appSecret,
			domain: LARK_OPEN_HOSTS[options.credentials.brand],
			logger: silentLogger,
			loggerLevel: LoggerLevel.error,
			handshakeTimeoutMs: 15_000,
			onReady: () => {
				if (!this.closed) options.onState("connected");
			},
			onReconnected: () => {
				if (!this.closed) options.onState("connected");
			},
			onReconnecting: () => {
				if (!this.closed) options.onState("degraded");
			},
			onError: () => {
				if (!this.closed) options.onState("degraded");
			},
		});
	}

	get chatId(): string | undefined {
		return this.gate.chatId;
	}

	async start(): Promise<void> {
		if (this.closed || this.started) throw new Error("Lark transport cannot be restarted");
		this.started = true;
		try {
			await this.socket.start({ eventDispatcher: this.dispatcher });
		} catch {
			this.close();
			throw new Error("Lark transport failed to start");
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.gate.close();
		this.socket.close({ force: true });
	}
}
