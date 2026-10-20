import { theme } from "@step-harness/coding-agent";
import { Spacer, Text } from "@step-harness/pi-tui";
import { nameCommand } from "#commands/name";
import type { RuntimeContext } from "./context.ts";

/** Display command outcomes; pending request state belongs to the input runtime. */
export async function handleNameCommand(ctx: RuntimeContext, text: string): Promise<void> {
	ctx.nameRequest?.abort();
	const controller = new AbortController();
	ctx.nameRequest = controller;
	const session = ctx.session;
	const request = nameCommand.parse(text);
	if (request.kind === "regenerate") {
		const currentName = session.sessionManager.getSessionName();
		ctx.showStatus(
			currentName ? `Generating session name (current: ${currentName})...` : "Generating session name...",
		);
	}
	try {
		const result = await nameCommand.run(session, request, controller.signal);
		if (controller.signal.aborted || ctx.session !== session) return;
		switch (result.status) {
			case "set":
				if (result.name !== result.requestedName) {
					ctx.showWarning(
						`Session name was normalized from ${JSON.stringify(result.requestedName)} to ${JSON.stringify(result.name)}`,
					);
				}
				ctx.chatContainer.addChild(new Spacer(1));
				ctx.chatContainer.addChild(
					new Text(theme.fg("dim", `Session name set: ${result.name ?? result.requestedName}`), 1, 0),
				);
				ctx.redraw.requestRender();
				break;
			case "renamed":
				ctx.showStatus(`Session name set: ${result.title}`);
				break;
			case "unchanged":
				ctx.showStatus(`Session name unchanged: ${result.title}`);
				break;
			case "empty":
				ctx.showWarning("Nothing to name yet. Send a message first, or use /name <name>");
				break;
			case "no-model":
				ctx.showWarning("No model selected. Use /name <name> to set a name manually");
				break;
			case "failed":
				ctx.showWarning("Could not generate a session name. Use /name <name> to set one manually");
				break;
			case "superseded":
				break;
		}
	} catch (error) {
		if (!controller.signal.aborted && ctx.session === session) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	} finally {
		if (ctx.nameRequest === controller) ctx.nameRequest = undefined;
	}
}
