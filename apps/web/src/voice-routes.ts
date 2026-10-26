import type { IncomingMessage, ServerResponse } from "node:http";
import { VoiceError, type VoiceRelay } from "./voice.ts";

/** Base64 of the largest accepted chunk, plus JSON envelope slack. */
const MAX_VOICE_BODY_BYTES = 768 * 1024;

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		bytes += buffer.length;
		if (bytes > MAX_VOICE_BODY_BYTES)
			throw new VoiceError("Voice request exceeds the size limit", 413, "body-too-large");
		chunks.push(buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new VoiceError("Invalid voice JSON", 400, "invalid-json");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new VoiceError("Voice body must be an object", 400, "invalid-json");
	return value as Record<string, unknown>;
}

/**
 * `/api/v1/voice/*`: the composer's microphone button. The caller must perform
 * the Host's cookie and Origin checks before dispatch, exactly as for
 * `terminalRoute`.
 *
 * The relay buffers the recording and transcribes it on `stop`, so the route
 * layer is plain request/response: audio goes up as JSON chunks, the transcript
 * comes back in the stop reply. No second websocket server, no SSE stream.
 */
export async function voiceRoute(
	voice: VoiceRelay,
	parts: string[],
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const method = request.method || "GET";
		if (parts.length === 0 && method === "GET") return reply(response, 200, voice.status());
		if (parts.length === 1 && parts[0] === "start" && method === "POST") {
			// A body is optional: an older client starts without one and gets the
			// capture default rate in its WAV header.
			const input = await readBody(request);
			const session = voice.start({ sampleRate: input.sampleRate });
			return reply(response, 200, session);
		}
		if (parts.length === 1 && parts[0] === "audio" && method === "POST") {
			const input = await readBody(request);
			voice.append(input.data);
			return reply(response, 202, { ok: true });
		}
		if (parts.length === 1 && parts[0] === "stop" && method === "POST") {
			const transcript = await voice.stop();
			return reply(response, 200, transcript);
		}
		if (parts.length === 1 && parts[0] === "cancel" && method === "POST") {
			voice.cancel();
			return reply(response, 200, { ok: true });
		}
		throw new VoiceError("Unknown voice route", 404, "not-found");
	} catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		const voiceError = error instanceof VoiceError ? error : undefined;
		reply(response, voiceError?.status ?? 500, {
			error: error instanceof Error ? error.message : String(error),
			...(voiceError ? { code: voiceError.code } : {}),
		});
	}
}
