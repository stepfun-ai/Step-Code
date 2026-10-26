import type { IncomingMessage, ServerResponse } from "node:http";
import { BROWSER_CREATE_TIMEOUT_MS, type WebBrowser } from "./browser.ts";
import { BrowserRequestError, readBrowserInput } from "./browser-policy.ts";

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

async function browserBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		bytes += buffer.length;
		if (bytes > 65536) throw new BrowserRequestError("Browser request exceeds 64 KiB", 413);
		chunks.push(buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new BrowserRequestError("Invalid browser JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new BrowserRequestError("Browser body must be an object");
	return value as Record<string, unknown>;
}

/** Called only after the host's cookie and Origin authorization. */
export async function browserRoute(
	browser: WebBrowser,
	parts: string[],
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const method = request.method ?? "GET";
		const tokenHeader = request.headers["x-stepcode-browser-control"];
		const token = typeof tokenHeader === "string" ? tokenHeader : "";
		if (!parts.length && method === "GET") {
			if (token) browser.touch(token);
			return reply(response, 200, browser.snapshot());
		}
		if (parts.length === 1 && parts[0] === "control") {
			if (method === "POST") return reply(response, 200, browser.acquire((await browserBody(request)).clientId));
			if (method === "DELETE") {
				browser.release(token);
				return reply(response, 200, { ok: true });
			}
		}
		browser.touch(token);
		if (parts.length === 3 && parts[0] === "tabs" && parts[2] === "selection" && method === "GET")
			return reply(response, 200, { text: await browser.command(token, () => browser.selection(parts[1])) });
		if (parts.length === 1 && parts[0] === "events" && method === "GET") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			let pendingSnapshot: string | undefined;
			const drain = () => {
				if (pendingSnapshot && !response.destroyed) {
					response.write(pendingSnapshot);
					pendingSnapshot = undefined;
				}
			};
			response.on("drain", drain);
			const unsubscribe = browser.subscribe(
				token,
				(event) => {
					if (response.destroyed || response.writableEnded) return;
					const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
					// Retain only the newest metadata while blocked; never queue screenshot frames. A control
					// event ends the stream right after, so it is always written: a displaced page that saw only
					// the end would take control back from its replacement.
					if (!response.writableNeedDrain || event.type === "closed" || event.type === "replaced")
						response.write(payload);
					else if (event.type === "snapshot") pendingSnapshot = payload;
				},
				() => response.end(),
			);
			const heartbeat = setInterval(() => {
				if (!response.writableNeedDrain && !response.destroyed) response.write(": heartbeat\n\n");
			}, 5000);
			response.once("close", () => {
				clearInterval(heartbeat);
				response.off("drain", drain);
				unsubscribe();
			});
			return;
		}
		const input = method === "DELETE" ? {} : await browserBody(request);
		if (parts.length === 1 && parts[0] === "tabs" && method === "POST") {
			return reply(
				response,
				201,
				await browser.command(token, () => browser.create(input.url), BROWSER_CREATE_TIMEOUT_MS),
			);
		}
		if (parts.length === 1 && parts[0] === "viewport" && method === "POST") {
			await browser.command(token, () => browser.resize(input.width, input.height));
			return reply(response, 200, { ok: true });
		}
		if (parts[0] === "tabs" && parts[1]) {
			const id = parts[1];
			if (parts.length === 2 && method === "DELETE") {
				await browser.command(token, () => browser.closeTab(id));
				return reply(response, 200, browser.snapshot());
			}
			if (parts.length === 3 && method === "POST") {
				if (parts[2] === "select") await browser.command(token, () => browser.select(id));
				else if (parts[2] === "action")
					await browser.command(token, () => browser.action(id, input.action, input.value));
				else if (parts[2] === "input") {
					const event = readBrowserInput(input);
					await browser.command(token, () => browser.input(id, event));
				} else throw new BrowserRequestError("Unknown browser route", 404);
				return reply(response, 200, browser.snapshot());
			}
		}
		throw new BrowserRequestError("Unknown browser route", 404);
	} catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		reply(response, error instanceof BrowserRequestError ? error.status : 503, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
