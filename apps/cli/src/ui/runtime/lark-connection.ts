import {
	type ExtensionContext,
	type ExtensionFactory,
	imageFileToContent,
	type MessageEndEvent,
	STEPCODE_VERSION,
	type UIDecisionRequest,
} from "@step-harness/coding-agent";
import {
	LarkApi,
	LarkDecisions,
	type LarkMessage,
	LarkRegistration,
	LarkTransport,
	larkCallbackSetupUrl,
} from "@step-harness/lark-adapter";
import type { ImageContent, TextContent } from "@step-harness/providers";
import { parseConnectCommand } from "../../commands/connect.ts";
import { createLarkPairingView } from "../view/dialogs/lark-pairing.ts";
import { LarkProjection } from "./lark-projection.ts";

interface Connection {
	controller: AbortController;
	context: ExtensionContext;
	api?: LarkApi;
	transport?: LarkTransport;
	input: Promise<void>;
	inputCount: number;
	blocked: boolean;
	compacting: boolean;
	projection?: LarkProjection;
	decisions: LarkDecisions;
	unsubscribeDecision?: () => void;
}

/** UI connection state only; session input and permissions stay in coding-agent. */
export function createLarkConnectionExtension(): ExtensionFactory {
	return (pi) => {
		let connection: Connection | undefined;
		const disconnect = async (notifyChat = false) => {
			const current = connection;
			connection = undefined;
			if (!current) return;
			const chat = current.transport?.chatId;
			current.controller.abort();
			current.unsubscribeDecision?.();
			current.decisions.close();
			current.projection?.close();
			current.transport?.close();
			current.context.ui.setWidget("lark-pairing", undefined);
			current.context.ui.setStatus("lark", undefined);
			if (notifyChat && current.api && chat) {
				await current.api
					.sendCard(chat, {
						config: { enable_forward: false },
						elements: [
							{
								tag: "div",
								text: {
									tag: "plain_text",
									content:
										"Terminal disconnected. This session no longer receives messages or handles remote approvals.",
								},
							},
						],
					})
					.catch(() => {});
			}
			await current.api?.close();
		};
		const mirrorDecision = (current: Connection, request: UIDecisionRequest) => {
			const chat = current.transport?.chatId;
			const api = current.api;
			if (!chat || !api || connection !== current || request.signal.aborted) return;
			if (
				request.options.length > 20 ||
				request.options.some((option) => option.length > 200) ||
				request.title.length > 200 ||
				(request.message?.length ?? 0) > 8000
			) {
				current.context.ui.notify(
					"This decision is too large for Lark. Use the terminal to review it in full.",
					"warning",
				);
				return;
			}
			const token = current.decisions.open(chat, request.options, (value) => {
				request.choose(value);
			});
			let cardId: string | undefined;
			const completed = () => {
				current.decisions.dismiss(token);
				current.controller.signal.removeEventListener("abort", detached);
				if (cardId && connection === current)
					void api
						.updateCard(cardId, {
							config: { enable_forward: false },
							elements: [
								{
									tag: "div",
									text: {
										tag: "plain_text",
										content: "Decision closed. This card can no longer approve a tool.",
									},
								},
							],
						})
						.catch(() => {});
			};
			const detached = () => {
				request.signal.removeEventListener("abort", completed);
				current.decisions.dismiss(token);
			};
			current.controller.signal.addEventListener("abort", detached, { once: true });
			request.signal.addEventListener("abort", completed, { once: true });
			void api
				.sendCard(chat, {
					config: { wide_screen_mode: true, enable_forward: false },
					header: { title: { tag: "plain_text", content: request.title } },
					elements: [
						{
							tag: "div",
							text: { tag: "plain_text", content: request.message ?? "Choose an option." },
						},
						...request.options.map((option) => ({
							tag: "action",
							actions: [
								{
									tag: "button",
									text: { tag: "plain_text", content: option },
									value: { token, option },
								},
							],
						})),
					],
				})
				.then((id) => {
					cardId = id;
					if (request.signal.aborted) completed();
				})
				.catch(() => {
					current.decisions.dismiss(token);
					request.signal.removeEventListener("abort", completed);
					current.controller.signal.removeEventListener("abort", detached);
					if (connection === current)
						current.context.ui.notify("Lark approval card failed. Use the terminal.", "warning");
				});
		};
		const receive = async (current: Connection, message: LarkMessage) => {
			if (connection !== current || current.controller.signal.aborted) return;
			if (current.blocked || current.compacting) {
				current.context.ui.notify(
					"Lark input ignored while a terminal dialog or compaction is active. Retry afterward.",
					"warning",
				);
				return;
			}
			const content: (TextContent | ImageContent)[] = [];
			const notes: string[] = message.text ? [message.text] : [];
			if (message.imageKeys.length + message.files.length > 8) throw new Error("Too many Lark attachments");
			for (const key of message.imageKeys) {
				const file = await current.api?.download(message.id, key, "image", "image");
				if (!file) continue;
				const image = await imageFileToContent(file.path);
				if (image) content.push(image);
				else notes.push("[Lark image omitted: unsupported image format.]");
			}
			for (const file of message.files) {
				const downloaded = await current.api?.download(message.id, file.key, file.name, "file");
				if (downloaded) notes.push(`[Lark file downloaded to local path ${JSON.stringify(downloaded.path)}]`);
			}
			if (connection !== current || current.controller.signal.aborted || current.blocked || current.compacting)
				return;
			if (notes.length) content.unshift({ type: "text", text: notes.join("\n\n") });
			if (!content.length) return;
			// Do not execute remote slash commands, login flows or editor actions.
			pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: false });
		};
		const pair = async (current: Connection) => {
			let stage = "pairing initialization";
			try {
				const registration = new LarkRegistration({ version: STEPCODE_VERSION.value });
				const code = await registration.begin(current.controller.signal);
				if (connection !== current) return;
				const pairing = await createLarkPairingView(code, () => process.stdout.rows || 40);
				if (connection !== current) return;
				current.context.ui.setWidget("lark-pairing", () => pairing);
				stage = "authorization polling";
				const result = await registration.waitForAuthorization(code, current.controller.signal);
				if (connection !== current) return;
				if (result.status !== "authorized") {
					await disconnect();
					current.context.ui.notify(
						result.status === "expired"
							? "Lark pairing expired. Retry /connect lark."
							: "Lark pairing denied. Retry /connect lark.",
						"warning",
					);
					return;
				}
				stage = "bot identity lookup";
				current.api = new LarkApi(result.credentials);
				const bot = await current.api.getBotIdentity();
				if (connection !== current) return;
				current.transport = new LarkTransport({
					credentials: result.credentials,
					botId: bot.openId,
					onMessage: (message) => {
						if (connection !== current || current.inputCount >= 16) return;
						current.inputCount++;
						current.input = current.input
							.then(() => receive(current, message))
							.catch(() => {
								if (connection === current)
									current.context.ui.notify("Lark input or attachment could not be delivered.", "warning");
							})
							.finally(() => {
								current.inputCount--;
							});
					},
					onCardAction: (action) => {
						if (connection === current) current.decisions.choose(action.token, action.chatId, action.option);
					},
					onState: (state) => {
						if (connection === current)
							current.context.ui.setStatus(
								"lark",
								`lark · ${state} · @${bot.name} · ${current.context.sessionManager.getSessionId()}`,
							);
					},
				});
				current.context.ui.setWidget("lark-pairing", undefined);
				current.context.ui.setStatus("lark", "Lark: connecting");
				stage = "WebSocket handshake";
				await current.transport.start();
				if (connection === current) {
					current.context.ui.setStatus(
						"lark",
						`lark · connected · @${bot.name} · ${current.context.sessionManager.getSessionId()}`,
					);
					current.context.ui.setWidget("lark-pairing", [
						"Lark connected. Enable card callbacks for remote approvals:",
						larkCallbackSetupUrl(result.credentials),
						"Confirm card.action.trigger in the browser. Keep this terminal connected.",
					]);
					current.context.ui.notify(
						`connect · lark · connected · @${bot.name} · ${current.context.sessionManager.getSessionId()}`,
					);
					current.context.ui.notify(
						"向飞书机器人发送消息即可绑定当前会话。使用 /connect off 断开。远程审批仍需通过上方链接确认 card.action.trigger 回调配置。",
					);
				}
			} catch {
				if (connection !== current) return;
				await disconnect();
				current.context.ui.notify(`Lark connection failed during ${stage}. Retry /connect lark.`, "warning");
			}
		};
		pi.registerCommand("connect", {
			description: "Mirror this terminal session to Lark; /connect off disconnects",
			handler: async (args, context) => {
				const intent = parseConnectCommand(args);
				if (intent === "invalid") {
					context.ui.notify("Usage: /connect lark | /connect off", "warning");
					return;
				}
				if (intent === "disconnect") {
					await disconnect(true);
					context.ui.notify("connect · lark · disconnected");
					return;
				}
				if (context.mode !== "tui") {
					context.ui.notify("Lark connection requires interactive terminal mode.", "warning");
					return;
				}
				if (connection) {
					context.ui.notify("Lark is already connecting or connected. Use /connect off first.", "warning");
					return;
				}
				const current: Connection = {
					controller: new AbortController(),
					context,
					input: Promise.resolve(),
					inputCount: 0,
					blocked: false,
					compacting: false,
					decisions: new LarkDecisions(),
				};
				connection = current;
				current.unsubscribeDecision = context.ui.onDecision?.((request) => mirrorDecision(current, request));
				context.ui.setStatus("lark", "Lark: pairing");
				void pair(current);
			},
		});
		pi.on("session_shutdown", () => disconnect());
		pi.on("before_agent_start", (event, context) => {
			const current = connection;
			const chat = current?.transport?.chatId;
			if (!current?.api || !chat) return;
			current.projection ??= new LarkProjection(current.api, chat, () => {
				if (connection === current) current.context.ui.setStatus("lark", "Lark: output failed");
			});
			current.projection.setSettings(context.model?.id, context.thinkingLevel);
			current.projection.begin(event.prompt);
		});
		pi.on("model_select", (event, context) => {
			connection?.projection?.setSettings(event.model.id, context.thinkingLevel);
		});
		pi.on("thinking_level_select", (event, context) => {
			connection?.projection?.setSettings(context.model?.id, event.level);
		});
		const projectAssistant = (event: Pick<MessageEndEvent, "message">) => {
			if (event.message.role === "assistant")
				connection?.projection?.update(
					event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				);
		};
		pi.on("message_update", projectAssistant);
		pi.on("message_end", projectAssistant);
		pi.on("tool_execution_start", (event) => connection?.projection?.working(event.toolName));
		pi.on("agent_settled", () => connection?.projection?.done());
		pi.on("session_before_compact", () => {
			if (connection) connection.compacting = true;
		});
		pi.on("session_compact", () => {
			if (connection) connection.compacting = false;
		});
		pi.on("session_compact_failed", () => {
			if (connection) connection.compacting = false;
		});
		pi.on("ui_prompt_start", () => {
			if (connection) connection.blocked = true;
		});
		pi.on("ui_prompt_end", () => {
			if (connection) connection.blocked = false;
		});
	};
}
