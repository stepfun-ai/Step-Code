import { gzipSync } from "node:zlib";

export type LarkBrand = "feishu" | "lark";

export interface LarkCredentials {
	appId: string;
	appSecret: string;
	brand: LarkBrand;
}

export interface LarkPairingCode {
	deviceCode: string;
	verificationUrl: string;
	expiresInSeconds: number;
	pollIntervalSeconds: number;
}

export type LarkPairingResult =
	| { status: "authorized"; credentials: LarkCredentials }
	| { status: "pending" | "slow-down" | "denied" | "expired" };

type FormPoster = (url: string, form: Record<string, string>, signal: AbortSignal) => Promise<Record<string, unknown>>;

const ACCOUNTS = { feishu: "https://accounts.feishu.cn", lark: "https://accounts.larksuite.com" };
export const LARK_OPEN_HOSTS = { feishu: "https://open.feishu.cn", lark: "https://open.larksuite.com" };

/** Official CLI launcher contract; the user must confirm the configuration. */
export function larkCallbackSetupUrl(credentials: LarkCredentials): string {
	const addons = gzipSync(JSON.stringify({ callbacks: { items: ["card.action.trigger"] } })).toString("base64url");
	const params = new URLSearchParams({ clientID: credentials.appId, addons });
	return `${LARK_OPEN_HOSTS[credentials.brand]}/page/launcher?${params}`;
}

async function postForm(
	url: string,
	form: Record<string, string>,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form),
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	const data: unknown = await response.json();
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Lark pairing response");
	if (!response.ok) {
		const error = (data as Record<string, unknown>).error;
		// Device authorization can report normal polling outcomes with HTTP 400.
		if (
			form.action !== "poll" ||
			response.status !== 400 ||
			typeof error !== "string" ||
			!["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(error)
		)
			throw new Error(`Lark pairing request failed (HTTP ${response.status})`);
		return { error, user_info: (data as Record<string, unknown>).user_info };
	}
	return data as Record<string, unknown>;
}

/** One in-memory registration attempt; credentials never enter configuration or diagnostics. */
export class LarkRegistration {
	private readonly version: string;
	private readonly post: FormPoster;
	private brand: LarkBrand = "feishu";
	private brandResolved = false;

	constructor(options: { version: string; post?: FormPoster }) {
		this.version = options.version;
		this.post = options.post ?? postForm;
	}

	async begin(signal: AbortSignal): Promise<LarkPairingCode> {
		signal.throwIfAborted();
		const data = await this.post(
			`${ACCOUNTS.feishu}/oauth/v1/app/registration`,
			{
				action: "begin",
				archetype: "PersonalAgent",
				auth_method: "client_secret",
				request_user_info: "open_id tenant_brand",
			},
			signal,
		);
		signal.throwIfAborted();
		const expires = data.expires_in ?? data.expire_in ?? 300;
		const interval = data.interval ?? 5;
		if (
			typeof data.device_code !== "string" ||
			!data.device_code ||
			typeof data.user_code !== "string" ||
			!data.user_code ||
			typeof expires !== "number" ||
			!Number.isFinite(expires) ||
			expires <= 0 ||
			typeof interval !== "number" ||
			!Number.isFinite(interval) ||
			interval <= 0
		)
			throw new Error("Invalid Lark pairing response");
		const params = new URLSearchParams({
			user_code: data.user_code,
			lpv: this.version,
			ocv: this.version,
			from: "cli",
		});
		return {
			deviceCode: data.device_code,
			verificationUrl: `${LARK_OPEN_HOSTS.feishu}/page/cli?${params}`,
			expiresInSeconds: expires,
			pollIntervalSeconds: interval,
		};
	}

	async poll(deviceCode: string, signal: AbortSignal): Promise<LarkPairingResult> {
		signal.throwIfAborted();
		const data = await this.post(
			`${ACCOUNTS[this.brand]}/oauth/v1/app/registration`,
			{
				action: "poll",
				device_code: deviceCode,
			},
			signal,
		);
		signal.throwIfAborted();
		const info = data.user_info;
		if (!this.brandResolved && info && typeof info === "object" && !Array.isArray(info)) {
			const raw = (info as Record<string, unknown>).tenant_brand;
			if (typeof raw === "string") {
				const brand = raw.toLowerCase();
				if (brand.includes("lark") || brand.includes("feishu")) {
					this.brand = brand.includes("lark") ? "lark" : "feishu";
					this.brandResolved = true;
				}
			}
		}
		if (
			typeof data.client_id === "string" &&
			data.client_id &&
			typeof data.client_secret === "string" &&
			data.client_secret
		) {
			return {
				status: "authorized",
				credentials: { appId: data.client_id, appSecret: data.client_secret, brand: this.brand },
			};
		}
		if (!data.error || data.error === "authorization_pending") return { status: "pending" };
		if (data.error === "slow_down") return { status: "slow-down" };
		if (data.error === "expired_token") return { status: "expired" };
		return { status: "denied" };
	}

	async waitForAuthorization(code: LarkPairingCode, signal: AbortSignal): Promise<LarkPairingResult> {
		signal.throwIfAborted();
		const deadline = Date.now() + code.expiresInSeconds * 1000;
		let interval = code.pollIntervalSeconds * 1000;
		while (Date.now() < deadline) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => {
						signal.removeEventListener("abort", abort);
						resolve();
					},
					Math.min(interval, deadline - Date.now()),
				);
				const abort = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
			});
			signal.throwIfAborted();
			if (Date.now() >= deadline) break;
			const remaining = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
			let result: LarkPairingResult;
			try {
				result = await this.poll(code.deviceCode, AbortSignal.any([signal, remaining]));
			} catch (error) {
				signal.throwIfAborted();
				if (remaining.aborted) return { status: "expired" };
				throw error;
			}
			if (result.status === "slow-down") interval += 5000;
			else if (result.status !== "pending") return result;
		}
		return { status: "expired" };
	}
}
