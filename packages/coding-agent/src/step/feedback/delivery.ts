import {
	listPendingFeedback,
	normalizePendingFeedbackBundle,
	readPendingFeedbackBundleResult,
	removePendingFeedback,
	writePendingFeedback,
	writePendingFeedbackBundle,
} from "./pending-store.ts";
import type { FeedbackSubmission } from "./types.ts";

export type FeedbackDeliveryFailureReason = "unsupported-endpoint" | "too-large" | "rejected" | "unreachable";
export type FeedbackBundleFailureReason = FeedbackDeliveryFailureReason | "body-pending" | "body-missing";

const FEEDBACK_FAILURE_REASONS: Readonly<Record<FeedbackDeliveryFailureReason, string>> = {
	"unsupported-endpoint": "The collector has no feedback route yet.",
	"too-large": "The collector rejected the submission as too large.",
	rejected: "The collector refused the submission.",
	unreachable: "Could not reach the collector.",
};

const FEEDBACK_BUNDLE_FAILURE_REASONS: Readonly<Record<FeedbackDeliveryFailureReason, string>> = {
	"unsupported-endpoint": "The collector has no upload route yet.",
	"too-large": "The collector rejected the archive as too large.",
	rejected: "The collector refused the archive.",
	unreachable: "Could not reach the collector.",
};

export const FEEDBACK_FAILURE_NEXT_STEPS: Readonly<Record<FeedbackDeliveryFailureReason, string>> = {
	"unsupported-endpoint": "Run `step feedback --retry` once the server is upgraded.",
	"too-large": "Retrying the same text cannot work; shorten it and send it again.",
	rejected: "Retrying the same text cannot work; check the client version or tell the maintainers.",
	unreachable: "Run `step feedback --retry` to send it again.",
};

export type FeedbackBundleOutcome =
	| { status: "uploaded"; bytes: number }
	| {
			status: "pending";
			reason: FeedbackBundleFailureReason;
			statusCode?: number;
			pendingPath?: string;
			bodyPendingPath?: string;
	  };

export type FeedbackDeliveryOutcome =
	| { status: "delivered"; feedbackId: string; bundle?: FeedbackBundleOutcome }
	| {
			status: "pending";
			feedbackId: string;
			reason: FeedbackDeliveryFailureReason;
			statusCode?: number;
			pendingPath?: string;
			bundle?: FeedbackBundleOutcome;
	  };

export interface FeedbackBundleAttachment {
	endpoint?: string;
	data: Uint8Array;
}

export interface DeliverFeedbackOptions {
	endpoint: string;
	submission: FeedbackSubmission;
	storageRootDir: string;
	bundle?: FeedbackBundleAttachment;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	retryBackoffsMs?: readonly number[];
	requestTimeoutMs?: number;
}

export interface RetryPendingFeedbackOptions extends Omit<DeliverFeedbackOptions, "submission" | "bundle"> {
	bundleEndpoint?: string;
}

export interface PendingFeedbackRetryOutcome {
	feedbackId: string;
	body?: FeedbackDeliveryOutcome;
	bundle?: FeedbackBundleOutcome;
}

export function describeFeedbackFailure(input: { reason: FeedbackDeliveryFailureReason; statusCode?: number }): string {
	const status = input.statusCode === undefined ? "" : ` (HTTP ${input.statusCode})`;
	return `${FEEDBACK_FAILURE_REASONS[input.reason]}${status}`;
}

export function describeFeedbackBundleFailure(input: {
	reason: FeedbackBundleFailureReason;
	statusCode?: number;
}): string {
	if (input.reason === "body-pending") return "The report it belongs to has not been accepted yet.";
	if (input.reason === "body-missing") return "The collector does not have the report body required for this archive.";
	const status = input.statusCode === undefined ? "" : ` (HTTP ${input.statusCode})`;
	return `${FEEDBACK_BUNDLE_FAILURE_REASONS[input.reason]}${status}`;
}

const DEFAULT_BACKOFFS = [1_000, 4_000, 16_000] as const;
const DEFAULT_TIMEOUT = 10_000;

export async function deliverFeedback(options: DeliverFeedbackOptions): Promise<FeedbackDeliveryOutcome> {
	const { feedbackId } = options.submission;
	const body = await postJson(options);
	if (!body.ok) {
		const pendingPath = await saveBody(options.storageRootDir, options.submission);
		const bundlePath = options.bundle ? await saveBundle(options) : undefined;
		const bundle = options.bundle
			? ({
					status: "pending",
					reason: "body-pending",
					...(bundlePath ? { pendingPath: bundlePath } : {}),
					...(pendingPath ? { bodyPendingPath: pendingPath } : {}),
				} satisfies FeedbackBundleOutcome)
			: undefined;
		return {
			status: "pending",
			feedbackId,
			reason: body.reason,
			...(body.statusCode === undefined ? {} : { statusCode: body.statusCode }),
			...(pendingPath ? { pendingPath } : {}),
			...(bundle ? { bundle } : {}),
		};
	}

	if (!options.bundle) return { status: "delivered", feedbackId };
	const uploaded = await postBundle(options.bundle, feedbackId, options);
	if (uploaded.ok)
		return { status: "delivered", feedbackId, bundle: { status: "uploaded", bytes: options.bundle.data.byteLength } };
	const pendingPath = await saveBundle(options);
	// Keep a recovery copy of the body while the archive is pending.
	const bodyPendingPath = await saveBody(options.storageRootDir, options.submission);
	return {
		status: "delivered",
		feedbackId,
		bundle: {
			status: "pending",
			reason: uploaded.reason,
			...(uploaded.statusCode === undefined ? {} : { statusCode: uploaded.statusCode }),
			...(pendingPath ? { pendingPath } : {}),
			...(bodyPendingPath ? { bodyPendingPath } : {}),
		},
	};
}

export async function retryPendingFeedback(
	options: RetryPendingFeedbackOptions,
): Promise<PendingFeedbackRetryOutcome[]> {
	const entries = await listPendingFeedback(options.storageRootDir);
	const outcomes: PendingFeedbackRetryOutcome[] = [];
	const retryWalls: RetryWalls = { unreachableHosts: new Set<string>() };
	for (const entry of entries) {
		let body: FeedbackDeliveryOutcome | undefined;
		if (entry.bodyInvalidPath) {
			// A body file can be edited or truncated after the original submission.
			// Do not treat a paired bundle as independently retryable: the collector
			// requires the report row first, and uploading the archive would detach
			// user conversation data from an untrusted report body.
			body = {
				status: "pending",
				feedbackId: entry.feedbackId,
				reason: "rejected",
				pendingPath: entry.bodyInvalidPath,
			};
		} else if (entry.body) {
			const posted =
				bodyRetryWall(retryWalls, options.endpoint) ??
				(await postJson({ ...options, submission: entry.body.submission }));
			if (posted.ok) {
				body = { status: "delivered", feedbackId: entry.feedbackId };
			} else {
				rememberRetryWall(retryWalls, posted, options.endpoint, "body");
				body = {
					status: "pending",
					feedbackId: entry.feedbackId,
					reason: posted.reason,
					...(posted.statusCode === undefined ? {} : { statusCode: posted.statusCode }),
					pendingPath: entry.body.path,
				};
			}
		}

		let bundle: FeedbackBundleOutcome | undefined;
		if (entry.bundlePath) {
			if (body?.status === "pending") {
				bundle = {
					status: "pending",
					reason: "body-pending",
					pendingPath: entry.bundlePath,
					...(entry.bodyInvalidPath ? { bodyPendingPath: entry.bodyInvalidPath } : {}),
				};
			} else if (!options.bundleEndpoint) {
				bundle = { status: "pending", reason: "unsupported-endpoint", pendingPath: entry.bundlePath };
			} else {
				const readResult = await readPendingFeedbackBundleResult(entry.bundlePath);
				if (readResult.status === "ready") {
					const data = readResult.data;
					const normalized = await normalizePendingFeedbackBundle(data);
					if (!normalized) {
						bundle = { status: "pending", reason: "rejected", pendingPath: entry.bundlePath };
					} else {
						const posted =
							bundleRetryWall(retryWalls, options.bundleEndpoint) ??
							(await postBundle(
								{ endpoint: options.bundleEndpoint, data: normalized },
								entry.feedbackId,
								options,
							));
						if (posted.ok) {
							bundle = { status: "uploaded", bytes: normalized.byteLength };
							await removePendingFeedback(entry.bundlePath).catch(() => undefined);
						} else {
							rememberRetryWall(retryWalls, posted, options.bundleEndpoint, "bundle");
							bundle = {
								status: "pending",
								reason: posted.reason,
								...(posted.statusCode === undefined ? {} : { statusCode: posted.statusCode }),
								pendingPath: entry.bundlePath,
							};
						}
					}
				} else {
					bundle = {
						status: "pending",
						reason: readResult.status === "too-large" ? "too-large" : "unreachable",
						pendingPath: entry.bundlePath,
					};
				}
			}
		}
		if (bundle?.status === "pending" && entry.body) bundle.bodyPendingPath = entry.body.path;

		if (body?.status === "delivered" && (!entry.bundlePath || bundle?.status === "uploaded") && entry.body) {
			await removePendingFeedback(entry.body.path).catch(() => undefined);
		}
		if (body || bundle)
			outcomes.push({ feedbackId: entry.feedbackId, ...(body ? { body } : {}), ...(bundle ? { bundle } : {}) });
	}
	return outcomes;
}

async function saveBody(storageRootDir: string, submission: FeedbackSubmission): Promise<string | undefined> {
	try {
		return await writePendingFeedback({ storageRootDir, submission });
	} catch {
		return undefined;
	}
}

async function saveBundle(options: {
	storageRootDir: string;
	submission: FeedbackSubmission;
	bundle?: FeedbackBundleAttachment;
}): Promise<string | undefined> {
	if (!options.bundle) return undefined;
	try {
		return await writePendingFeedbackBundle({
			storageRootDir: options.storageRootDir,
			feedbackId: options.submission.feedbackId,
			data: options.bundle.data,
		});
	} catch {
		return undefined;
	}
}

type PostFailure = { ok: false; reason: FeedbackDeliveryFailureReason; statusCode?: number };
type PostResult = { ok: true } | PostFailure;
type BundlePostFailure = { ok: false; reason: FeedbackBundleFailureReason; statusCode?: number };
type BundlePostResult = { ok: true } | BundlePostFailure;
type UnsupportedPostFailure = { ok: false; reason: "unsupported-endpoint"; statusCode?: number };

interface RetryWalls {
	unreachableHosts: Set<string>;
	bodyUnsupported?: UnsupportedPostFailure;
	bundleUnsupported?: UnsupportedPostFailure;
}

function bodyRetryWall(walls: RetryWalls, endpoint: string): PostFailure | undefined {
	return hasUnreachableHost(walls, endpoint) ? { ok: false, reason: "unreachable" } : walls.bodyUnsupported;
}

function bundleRetryWall(walls: RetryWalls, endpoint: string): BundlePostFailure | undefined {
	return hasUnreachableHost(walls, endpoint) ? { ok: false, reason: "unreachable" } : walls.bundleUnsupported;
}

function rememberRetryWall(
	walls: RetryWalls,
	failure: PostFailure | BundlePostFailure,
	endpoint: string,
	route: "body" | "bundle",
): void {
	if (failure.reason === "unreachable") {
		const host = endpointHost(endpoint);
		if (host) walls.unreachableHosts.add(host);
		return;
	}
	if (failure.reason !== "unsupported-endpoint") return;
	const wall = {
		ok: false,
		reason: "unsupported-endpoint",
		...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
	} satisfies UnsupportedPostFailure;
	if (route === "body") walls.bodyUnsupported = wall;
	else walls.bundleUnsupported = wall;
}

function hasUnreachableHost(walls: RetryWalls, endpoint: string): boolean {
	const host = endpointHost(endpoint);
	return host !== undefined && walls.unreachableHosts.has(host);
}

function endpointHost(endpoint: string): string | undefined {
	try {
		return new URL(endpoint).host.toLowerCase();
	} catch {
		return undefined;
	}
}

async function postJson(options: {
	endpoint: string;
	submission: FeedbackSubmission;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	retryBackoffsMs?: readonly number[];
	requestTimeoutMs?: number;
}): Promise<PostResult> {
	return post(options.endpoint, JSON.stringify(options.submission), "application/json", options, classifyStatus);
}

async function postBundle(
	bundle: FeedbackBundleAttachment,
	feedbackId: string,
	options: {
		fetchImpl?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		retryBackoffsMs?: readonly number[];
		requestTimeoutMs?: number;
	},
): Promise<BundlePostResult> {
	if (!bundle.endpoint) return { ok: false, reason: "unsupported-endpoint" };
	let endpoint: string;
	try {
		const url = new URL(bundle.endpoint);
		url.searchParams.set("feedbackId", feedbackId);
		endpoint = url.toString();
	} catch {
		return { ok: false, reason: "unreachable" };
	}
	return post(endpoint, Buffer.from(bundle.data), "application/gzip", options, classifyBundleStatus);
}

function post(
	endpoint: string,
	body: string | Uint8Array,
	contentType: string,
	options: {
		fetchImpl?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		retryBackoffsMs?: readonly number[];
		requestTimeoutMs?: number;
	},
	classify: typeof classifyStatus,
): Promise<PostResult>;
function post(
	endpoint: string,
	body: string | Uint8Array,
	contentType: string,
	options: {
		fetchImpl?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		retryBackoffsMs?: readonly number[];
		requestTimeoutMs?: number;
	},
	classify: typeof classifyBundleStatus,
): Promise<BundlePostResult>;
async function post(
	endpoint: string,
	body: string | Uint8Array,
	contentType: string,
	options: {
		fetchImpl?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		retryBackoffsMs?: readonly number[];
		requestTimeoutMs?: number;
	},
	classify: (status: number) => FeedbackDeliveryFailureReason | FeedbackBundleFailureReason,
): Promise<PostResult | BundlePostResult> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const backoffs = options.retryBackoffsMs ?? DEFAULT_BACKOFFS;
	let lastStatusCode: number | undefined;
	for (let attempt = 0; ; attempt += 1) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? DEFAULT_TIMEOUT);
			try {
				const response = await fetchImpl(endpoint, {
					method: "POST",
					headers: { "content-type": contentType },
					body,
					signal: controller.signal,
				});
				if (response.ok) return { ok: true };
				if (response.status !== 429 && (response.status < 500 || response.status >= 600)) {
					return { ok: false, reason: classify(response.status), statusCode: response.status };
				}
				lastStatusCode = response.status;
			} finally {
				clearTimeout(timeout);
			}
		} catch {
			return { ok: false, reason: "unreachable" };
		}
		if (attempt >= backoffs.length) {
			return {
				ok: false,
				reason: "unreachable",
				...(lastStatusCode === undefined ? {} : { statusCode: lastStatusCode }),
			};
		}
		const delay = backoffs[attempt];
		if (delay === undefined) return { ok: false, reason: "unreachable" };
		try {
			await (options.sleep ?? sleep)(delay);
		} catch {
			return { ok: false, reason: "unreachable" };
		}
	}
}

function classifyStatus(status: number): FeedbackDeliveryFailureReason {
	if (status === 404) return "unsupported-endpoint";
	if (status === 413) return "too-large";
	return "rejected";
}

function classifyBundleStatus(status: number): FeedbackBundleFailureReason {
	if (status === 409) return "body-missing";
	return classifyStatus(status);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
