import { createRequire } from "node:module";
import type { WorkflowJsonSchema, WorkflowMeta } from "./types.ts";

const require = createRequire(import.meta.url);
const MAX_SCRIPT_BYTES = 128 * 1024;
const DEFAULT_MEMORY_LIMIT_MB = 64;
const DEFAULT_TIMEOUT_MS = 120_000;

interface IsolatedContext {
	global: {
		set(name: string, value: unknown): Promise<void>;
	};
}

interface IsolatedScript {
	run(context: IsolatedContext, options: { promise: true; copy: true; timeout: number }): Promise<unknown>;
}

interface IsolatedReference {
	applySync(receiver: unknown, args?: unknown[], options?: unknown): unknown;
	apply(receiver: unknown, args?: unknown[], options?: unknown): Promise<unknown>;
}

interface IsolatedModule {
	Isolate: new (options?: {
		memoryLimit?: number;
	}) => {
		createContext(): Promise<IsolatedContext>;
		compileScript(code: string, options?: { filename?: string }): Promise<IsolatedScript>;
		dispose(): void;
	};
	ExternalCopy: new (value: unknown) => { copyInto(): unknown };
	Reference: new (value: (...args: unknown[]) => unknown) => IsolatedReference;
}

interface HostCallTracker {
	pending: number;
	onSettled?: () => void;
}

export interface WorkflowVmHost {
	agent(prompt: string, options: Record<string, unknown>): Promise<unknown>;
	phase(title: string): void;
	log(message: string): void;
	iterate(options: Record<string, unknown>): Promise<unknown>;
	nestedWorkflow(name: string, args: unknown): Promise<unknown>;
	budgetSpent(): number;
	budgetRemaining(): number;
	budgetTotal(): number | null;
}

export interface WorkflowVmOptions {
	filename?: string;
	memoryLimitMb?: number;
	timeoutMs?: number;
	replay?: boolean;
}

export interface WorkflowVmResult {
	value: unknown;
	meta: WorkflowMeta;
}

/** Resolve the native module without making it a startup requirement. */
export function loadIsolatedVm(): IsolatedModule | undefined {
	try {
		const loaded: unknown = require("isolated-vm");
		if (!loaded || typeof loaded !== "object") return undefined;
		const candidate = loaded as Partial<IsolatedModule>;
		if (
			typeof candidate.Isolate !== "function" ||
			typeof candidate.ExternalCopy !== "function" ||
			typeof candidate.Reference !== "function"
		) {
			return undefined;
		}
		return candidate as IsolatedModule;
	} catch {
		return undefined;
	}
}

export function isIsolatedVmAvailable(): boolean {
	return loadIsolatedVm() !== undefined;
}

/**
 * Whether this runtime can host isolated-vm. isolated-vm is a native addon that
 * links V8's C++ API directly, so the bun single-binary we ship — engine is
 * JavaScriptCore, not V8 — can never load it however it is installed, while
 * Node can. We key off bun explicitly rather than probing `process.versions.v8`
 * because bun fills in a node-compat `process.versions.v8` (and `.node`) too, so
 * a v8-key test would wrongly report bun as hostable. This is therefore a bun
 * check, not a general non-V8 detector: any other (hypothetical) non-V8 runtime
 * is treated as hostable and would still get the actionable warning. Callers use
 * it to separate a fixable install gap (Node: warn, "reinstall isolated-vm"
 * works) from an unfixable runtime fact (the shipped binary: stay silent).
 */
export function isIsolatedVmHostable(): boolean {
	return !("bun" in process.versions);
}

/** Run a workflow script inside an isolated-vm context. */
export async function runInIsolatedVm(
	script: string,
	args: unknown,
	host: WorkflowVmHost,
	options: WorkflowVmOptions = {},
): Promise<WorkflowVmResult> {
	const sourceBytes = Buffer.byteLength(script, "utf8");
	if (sourceBytes > MAX_SCRIPT_BYTES) throw new Error(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes`);
	const ivm = loadIsolatedVm();
	if (!ivm) throw new Error("Workflow runtime unavailable: isolated-vm is not installed or failed to load");
	const isolate = new ivm.Isolate({ memoryLimit: clampMemory(options.memoryLimitMb) });
	try {
		const context = await isolate.createContext();
		await context.global.set("args", new ivm.ExternalCopy(toJsonSafe(args)).copyInto());
		const hostCalls: HostCallTracker = { pending: 0 };
		await installHostBridge(ivm, context, host, hostCalls);
		const wrapped = buildScript(script, options.replay === true);
		const compiled = await isolate.compileScript(wrapped, { filename: options.filename ?? "workflow.js" });
		const timeoutMs = clampTimeout(options.timeoutMs);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let rejectTimeout: ((reason?: unknown) => void) | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			rejectTimeout = reject;
		});
		const checkTimeout = (): void => {
			if (hostCalls.pending > 0) {
				timeout = setTimeout(checkTimeout, Math.min(100, timeoutMs));
				return;
			}
			rejectTimeout?.(new Error(`Workflow script timed out after ${timeoutMs}ms`));
		};
		const armTimeout = (): void => {
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(checkTimeout, timeoutMs);
		};
		hostCalls.onSettled = (): void => {
			if (hostCalls.pending === 0) armTimeout();
		};
		armTimeout();
		try {
			const result = await Promise.race([
				compiled.run(context, {
					promise: true,
					copy: true,
					timeout: timeoutMs,
				}),
				timeoutPromise,
			]);
			if (!result || typeof result !== "object" || Array.isArray(result)) {
				return { value: result ?? null, meta: {} };
			}
			const record = result as { value?: unknown; meta?: unknown };
			return {
				value: record.value ?? null,
				meta: normalizeMeta(record.meta),
			};
		} finally {
			if (timeout) clearTimeout(timeout);
			hostCalls.onSettled = undefined;
		}
	} finally {
		isolate.dispose();
	}
}

async function installHostBridge(
	ivm: IsolatedModule,
	context: IsolatedContext,
	host: WorkflowVmHost,
	hostCalls: HostCallTracker,
): Promise<void> {
	const agentReference = new ivm.Reference(async (...rawArgs: unknown[]) => {
		const prompt = typeof rawArgs[0] === "string" ? rawArgs[0] : String(rawArgs[0] ?? "");
		const options = isRecord(rawArgs[1]) ? rawArgs[1] : {};
		return trackHostCall(hostCalls, () => host.agent(prompt, options));
	});
	const iterateReference = new ivm.Reference(async (...rawArgs: unknown[]) =>
		trackHostCall(hostCalls, () => host.iterate(isRecord(rawArgs[0]) ? rawArgs[0] : {})),
	);
	const workflowReference = new ivm.Reference(async (...rawArgs: unknown[]) => {
		const name = typeof rawArgs[0] === "string" ? rawArgs[0] : "";
		return trackHostCall(hostCalls, () => host.nestedWorkflow(name, rawArgs[1] ?? null));
	});
	const phaseReference = new ivm.Reference((...rawArgs: unknown[]) => {
		host.phase(String(rawArgs[0] ?? ""));
		return null;
	});
	const logReference = new ivm.Reference((...rawArgs: unknown[]) => {
		host.log(String(rawArgs[0] ?? ""));
		return null;
	});
	const spentReference = new ivm.Reference(() => host.budgetSpent());
	const remainingReference = new ivm.Reference(() => host.budgetRemaining());
	await context.global.set("__workflow_agent", agentReference);
	await context.global.set("__workflow_iterate", iterateReference);
	await context.global.set("__workflow_nested", workflowReference);
	await context.global.set("__workflow_phase", phaseReference);
	await context.global.set("__workflow_log", logReference);
	await context.global.set("__workflow_spent", spentReference);
	await context.global.set("__workflow_remaining", remainingReference);
	await context.global.set("__workflow_total", new ivm.ExternalCopy(host.budgetTotal()).copyInto());
}

function trackHostCall<T>(tracker: HostCallTracker, operation: () => Promise<T>): Promise<T> {
	tracker.pending += 1;
	return Promise.resolve()
		.then(operation)
		.finally(() => {
			tracker.pending = Math.max(0, tracker.pending - 1);
			tracker.onSettled?.();
		});
}

function buildScript(script: string, replay: boolean): string {
	const userSource = JSON.stringify(transformExports(script));
	const deterministicGuards = replay
		? `const __workflow_forbidden_now = () => { throw new Error("Non-deterministic clock access is disabled during workflow replay"); };`
		: `const __workflow_forbidden_now = () => { throw new Error("Workflow scripts cannot access wall-clock or random values"); };`;
	return `
(() => {
${deterministicGuards}
const __workflow_forbidden_date = function() { throw new Error("Workflow scripts cannot construct Date values"); };
Object.defineProperty(__workflow_forbidden_date, "now", { value: __workflow_forbidden_now, writable: false, configurable: false });
Object.defineProperty(globalThis, "Date", { value: __workflow_forbidden_date, writable: false, configurable: false });
Object.defineProperty(Math, "random", { value: __workflow_forbidden_now, writable: false, configurable: false });
const __workflow_forbidden_intl_date = function() { throw new Error("Workflow scripts cannot access wall-clock through Intl"); };
if (typeof Intl === "object" && Intl !== null) {
  Object.defineProperty(Intl, "DateTimeFormat", { value: __workflow_forbidden_intl_date, writable: false, configurable: false });
}
globalThis.__workflow_meta = null;
const __workflow_agent_ref = __workflow_agent;
const __workflow_iterate_ref = __workflow_iterate;
const __workflow_nested_ref = __workflow_nested;
const __workflow_phase_ref = __workflow_phase;
const __workflow_log_ref = __workflow_log;
const __workflow_spent_ref = __workflow_spent;
const __workflow_remaining_ref = __workflow_remaining;
for (const name of [
  "__workflow_agent",
  "__workflow_iterate",
  "__workflow_nested",
  "__workflow_phase",
  "__workflow_log",
  "__workflow_spent",
  "__workflow_remaining",
]) {
  Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
}
const __workflow_apply = (ref, values) => ref.apply(undefined, values, { arguments: { copy: true }, result: { promise: true, copy: true } });
const __workflow_apply_sync = (ref, values) => ref.applySync(undefined, values, { arguments: { copy: true }, result: { copy: true } });
globalThis.agent = async (prompt, options = {}) => __workflow_apply(__workflow_agent_ref, [prompt, options]);
globalThis.iterate = async (options) => __workflow_apply(__workflow_iterate_ref, [options || {}]);
globalThis.workflow = async (name, options = null) => __workflow_apply(__workflow_nested_ref, [name, options]);
globalThis.parallel = async (tasks) => {
  if (!Array.isArray(tasks)) throw new TypeError("parallel() requires an array of task functions");
  if (tasks.length > 4096) throw new RangeError("parallel() accepts at most 4096 tasks");
  return Promise.all(tasks.map(async (task) => {
    if (typeof task !== "function") throw new TypeError("parallel() entries must be functions");
    try { return await task(); } catch { return null; }
  }));
};
globalThis.pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new TypeError("pipeline() requires an array of items");
  if (items.length > 4096) throw new RangeError("pipeline() accepts at most 4096 items");
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions");
  }
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      try { value = await stage(value, item, index); } catch { return null; }
    }
    return value;
  }));
};
globalThis.phase = (title) => { __workflow_apply_sync(__workflow_phase_ref, [title]); };
globalThis.log = (message) => { __workflow_apply_sync(__workflow_log_ref, [message]); };
globalThis.budget = Object.freeze({
  total: __workflow_total,
  spent: () => __workflow_apply_sync(__workflow_spent_ref, []),
  remaining: () => __workflow_apply_sync(__workflow_remaining_ref, []),
});
Object.defineProperty(globalThis, "process", { value: undefined, writable: false, configurable: false });
Object.defineProperty(globalThis, "require", { value: undefined, writable: false, configurable: false });
Object.defineProperty(globalThis, "fetch", { value: undefined, writable: false, configurable: false });
const __workflow_main = Object.getPrototypeOf(async function() {}).constructor(${userSource});
return __workflow_main().then((__workflow_value) => ({
  value: __workflow_value === undefined ? null : __workflow_value,
  meta: globalThis.__workflow_meta || {},
}));
})()
`;
}

export function transformExports(script: string): string {
	return script
		.replace(/^[\t ]*export[\t ]+(?=(?:const|let|var|function|async[\t ]+function|class)\b)/gmu, "")
		.replace(/^[\t ]*(const|let|var)[\t ]+meta[\t ]*=/mu, "$1 meta = globalThis.__workflow_meta =")
		.replace(/^\s*export\s*\{[^}]*\};?\s*$/gmu, "");
}

export function clampMemory(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEMORY_LIMIT_MB;
	return Math.max(8, Math.min(256, Math.floor(value)));
}

export function clampTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(100, Math.min(600_000, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toJsonSafe(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
	if (typeof value === "object") {
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = toJsonSafe(item);
		return result;
	}
	return String(value);
}

export function normalizeMeta(value: unknown): WorkflowMeta {
	if (!isRecord(value)) return {};
	const meta: WorkflowMeta = {};
	if (typeof value.name === "string") meta.name = value.name.slice(0, 200);
	if (typeof value.description === "string") meta.description = value.description.slice(0, 2000);
	if (Array.isArray(value.phases)) {
		meta.phases = value.phases
			.filter((phase): phase is Record<string, unknown> => isRecord(phase) && typeof phase.title === "string")
			.slice(0, 100)
			.map((phase) => ({
				title: String(phase.title).slice(0, 200),
				...(typeof phase.detail === "string" ? { detail: phase.detail.slice(0, 1000) } : {}),
			}));
	}
	if (isRecord(value.roleSchemas)) {
		const roleSchemas = Object.create(null) as Record<string, WorkflowJsonSchema>;
		for (const [name, schema] of Object.entries(value.roleSchemas).slice(0, 32)) {
			if (name && isRecord(schema)) roleSchemas[name.slice(0, 100)] = toJsonSafe(schema) as WorkflowJsonSchema;
		}
		if (Object.keys(roleSchemas).length > 0) meta.roleSchemas = roleSchemas;
	}
	return meta;
}

export const WORKFLOW_MAX_SCRIPT_BYTES = MAX_SCRIPT_BYTES;
