/**
 * The workflow sandbox: QuickJS compiled to WebAssembly.
 *
 * A workflow script is authored by the model, so it runs isolated — no host
 * object references, no `process`/`require`/`fetch`, no wall clock and no
 * randomness (the last two keep journal replay deterministic), under a memory
 * cap and a timeout.
 *
 * QuickJS-on-WebAssembly is engine-agnostic, which is the point. The previous
 * sandbox, `isolated-vm`, is a native addon that links V8's C++ API directly, so
 * it could only load on a V8 host: the released executable is built with
 * `bun build --compile` and runs on JavaScriptCore, where that addon can never
 * load however it is installed. Workflows — and with them the ultraloop opt-in,
 * which shares the workflow registration gate — were therefore silently absent
 * from every released build while working fine in a source run on Node. One
 * engine for both runtimes removes that class of divergence, and costs nothing
 * that matters here: workflow scripts are orchestration code that spends its
 * time awaiting agents, not computing.
 *
 * Two constraints this file depends on, both learned the hard way:
 *
 *   - The `singlefile` QuickJS variant is mandatory. The default `wasmfile`
 *     variant loads `emscripten-module.wasm` from disk beside its own module,
 *     and that path does not exist inside a compiled executable's virtual
 *     filesystem (`ENOENT /$bunfs/root/emscripten-module.wasm`). `singlefile`
 *     inlines the module instead.
 *   - Every handle must be released before the context is disposed, and the
 *     context must be disposed before the runtime. Otherwise QuickJS aborts the
 *     entire WebAssembly instance on `JS_FreeRuntime` ("Assertion failed:
 *     list_empty(&rt->gc_obj_list)") — and since the module is cached
 *     process-wide, that poisons every later run in the session.
 *
 * Everything crossing the boundary is JSON text. QuickJS lives in its own
 * WebAssembly memory, so a guest value can never be a host object reference;
 * encoding explicitly keeps the copy semantics visible rather than implicit.
 * Values JSON cannot represent — functions, symbols — are not transferable, as
 * the VM contract already required.
 */

import type {
	QuickJSContext,
	QuickJSDeferredPromise,
	QuickJSHandle,
	QuickJSRuntime,
	QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { WorkflowJsonSchema, WorkflowMeta } from "./types.ts";

const MAX_SCRIPT_BYTES = 128 * 1024;
const DEFAULT_MEMORY_LIMIT_MB = 64;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Host primitives the guest prelude exposes as `agent`, `phase`, `log`, `iterate`, `workflow` and `budget`. */
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

/**
 * The WebAssembly module is process-wide and costs ~30ms to instantiate, so it
 * is built once on first use. Loading is dynamic so a session that never runs a
 * workflow never pays for the inlined module.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined;

async function loadQuickJsModule(): Promise<QuickJSWASMModule> {
	modulePromise ??= (async () => {
		const [core, variant] = await Promise.all([
			import("quickjs-emscripten-core"),
			import("@jitl/quickjs-singlefile-mjs-release-sync"),
		]);
		return core.newQuickJSWASMModuleFromVariant(variant.default);
	})();
	return modulePromise;
}

/** Bookkeeping shared between the watchdogs and the host bridge. */
interface HostCallTracker {
	pending: number;
	onSettled?: () => void;
	/** Pushes the interrupt deadline out; called whenever a host call settles. */
	refreshDeadline?: () => void;
	/**
	 * Deferred promises handed to the guest that have not settled yet. A script can
	 * return without awaiting them ("fire and forget"), so the run has to release
	 * them itself; leaving them alive aborts the whole WebAssembly instance.
	 */
	live: Set<QuickJSDeferredPromise>;
	/** Set just before the context is disposed. A late settlement must not touch the VM after this. */
	closed: boolean;
}

/** Run a workflow script inside a QuickJS WebAssembly context. */
export async function runInQuickJs(
	script: string,
	args: unknown,
	host: WorkflowVmHost,
	options: WorkflowVmOptions = {},
): Promise<WorkflowVmResult> {
	const sourceBytes = Buffer.byteLength(script, "utf8");
	if (sourceBytes > MAX_SCRIPT_BYTES) throw new Error(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes`);
	const quickjs = await loadQuickJsModule();
	const timeoutMs = clampTimeout(options.timeoutMs);
	const runtime = quickjs.newRuntime();
	runtime.setMemoryLimit(clampMemory(options.memoryLimitMb) * 1024 * 1024);

	const hostCalls: HostCallTracker = { pending: 0, live: new Set(), closed: false };
	/**
	 * Deadline for the in-VM interrupt handler, measured from the last sign of host
	 * activity rather than from the start of the run.
	 *
	 * It must not exempt pending host calls the way the host-side timer below does.
	 * The handler only runs while the guest is executing bytecode, so a guest parked
	 * on `await` never reaches it — which means the only situation an exemption
	 * could ever apply to is a guest burning CPU while a host call is in flight, and
	 * that is exactly the case that has to be stopped. Nothing else can stop it
	 * either: the loop runs inside the WebAssembly call and blocks the host event
	 * loop, so the timer cannot even fire.
	 *
	 * Refreshing on every settled call (not only when the last one settles) is what
	 * keeps a healthy fan-out alive: a wave whose first agent takes longer than
	 * `timeoutMs` would otherwise resume against a stale deadline and be interrupted
	 * mid-continuation — and `parallel`/`pipeline` would swallow that into a `null`
	 * entry, turning a spurious timeout into a silently wrong result.
	 */
	let interruptDeadline = Date.now() + timeoutMs;
	let timedOut = false;
	const refreshDeadline = (): void => {
		interruptDeadline = Date.now() + timeoutMs;
	};
	hostCalls.refreshDeadline = refreshDeadline;
	runtime.setInterruptHandler(() => {
		if (Date.now() <= interruptDeadline) return false;
		timedOut = true;
		return true;
	});

	const context = runtime.newContext();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let rejectTimeout: ((reason?: unknown) => void) | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const timeoutError = (): Error => new Error(`Workflow script timed out after ${timeoutMs}ms`);
	const checkTimeout = (): void => {
		if (hostCalls.pending > 0) {
			timeout = setTimeout(checkTimeout, Math.min(100, timeoutMs));
			return;
		}
		timedOut = true;
		rejectTimeout?.(timeoutError());
	};
	const armTimeout = (): void => {
		if (timeout) clearTimeout(timeout);
		refreshDeadline();
		timeout = setTimeout(checkTimeout, timeoutMs);
	};
	hostCalls.onSettled = (): void => {
		if (hostCalls.pending === 0) armTimeout();
	};

	// See the module header: release every handle before disposing the context, and
	// dispose the context before the runtime, or QuickJS aborts the whole instance.
	let evaluated: QuickJSHandle | undefined;
	let abandoned: QuickJSHandle | undefined;
	try {
		installHostBridge(context, runtime, host, hostCalls);
		setStringProp(context, "__workflow_args_json", argsJson(args));
		armTimeout();
		const result = context.evalCode(buildScript(script, options.replay === true), options.filename ?? "workflow.js");
		if (result.error) {
			throw toHostError(context, result.error, timedOut ? timeoutError() : undefined);
		}
		evaluated = result.value;
		const pending = context.resolvePromise(evaluated);
		// When the watchdog wins the race below, this settles afterwards; keep the
		// handle so the finally can release it instead of leaking it.
		void pending.then(
			(settled) => {
				abandoned = settled.error ?? settled.value;
			},
			() => {},
		);
		// An interrupt inside the guest's async body, or a synchronous throw, becomes
		// a rejected promise that nothing else will advance — pump once after
		// attaching, or an immediate failure never surfaces.
		runtime.executePendingJobs();
		const settled = await Promise.race([pending, timeoutPromise]);
		abandoned = undefined;
		if (settled.error) {
			throw toHostError(context, settled.error, timedOut ? timeoutError() : undefined);
		}
		const json = context.getString(settled.value);
		settled.value.dispose();
		return readResult(json);
	} finally {
		if (timeout) clearTimeout(timeout);
		hostCalls.onSettled = undefined;
		hostCalls.refreshDeadline = undefined;
		// A rejected timeoutPromise with no other listener would surface as an
		// unhandled rejection once this frame unwinds.
		timeoutPromise.catch(() => {});
		runtime.removeInterruptHandler();
		// Close the bridge before tearing anything down, so a host call that settles
		// from here on leaves the VM alone, then release the promises a fire-and-forget
		// script left behind.
		hostCalls.closed = true;
		for (const deferred of hostCalls.live) deferred.dispose();
		hostCalls.live.clear();
		abandoned?.dispose();
		evaluated?.dispose();
		context.dispose();
		runtime.dispose();
	}
}

/** `setProp` copies the value into the context, so the temporary handle is released right after. */
function setStringProp(context: QuickJSContext, key: string, value: string): void {
	const handle = context.newString(value);
	context.setProp(context.global, key, handle);
	handle.dispose();
}

function argsJson(args: unknown): string {
	return JSON.stringify(toJsonSafe(args)) ?? "null";
}

function readResult(json: string): WorkflowVmResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { value: null, meta: {} };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { value: parsed ?? null, meta: {} };
	}
	const record = parsed as { value?: unknown; meta?: unknown };
	return { value: record.value ?? null, meta: normalizeMeta(record.meta) };
}

/**
 * Convert a guest exception into a host Error. `override` replaces the message
 * when the failure was our own interrupt, so a timeout reports the timeout
 * instead of QuickJS's bare "interrupted".
 */
function toHostError(context: QuickJSContext, handle: QuickJSHandle, override?: Error): Error {
	const dumped: unknown = context.dump(handle);
	handle.dispose();
	if (override) return override;
	if (dumped && typeof dumped === "object") {
		const record = dumped as { name?: unknown; message?: unknown; stack?: unknown };
		const message = typeof record.message === "string" ? record.message : JSON.stringify(dumped);
		const error = new Error(message);
		if (typeof record.name === "string") error.name = record.name;
		if (typeof record.stack === "string") error.stack = `${record.name ?? "Error"}: ${message}\n${record.stack}`;
		return error;
	}
	return new Error(typeof dumped === "string" ? dumped : String(dumped));
}

/**
 * Install the host callbacks the guest prelude wires up. Async calls hand the
 * guest a deferred promise and pump the job queue once the host settles it —
 * this is what lets `await agent()` work without an Asyncify build.
 */
function installHostBridge(
	context: QuickJSContext,
	runtime: QuickJSRuntime,
	host: WorkflowVmHost,
	hostCalls: HostCallTracker,
): void {
	const asyncBridge = (name: string, operation: (args: unknown[]) => Promise<unknown>): void => {
		const fn = context.newFunction(name, (...handles) => {
			const values = handles.map((handle) => context.dump(handle));
			const deferred = context.newPromise();
			hostCalls.live.add(deferred);
			hostCalls.pending += 1;
			void Promise.resolve()
				.then(() => operation(values))
				.then(
					(result) => {
						// The run may already have returned without awaiting this call; the
						// context is gone and the deferred was released with it.
						if (hostCalls.closed) return;
						const encoded = context.newString(JSON.stringify(toJsonSafe(result)) ?? "null");
						deferred.resolve(encoded);
						encoded.dispose();
					},
					(error: unknown) => {
						if (hostCalls.closed) return;
						const message = error instanceof Error ? error.message : String(error);
						const encoded = context.newError(message);
						deferred.reject(encoded);
						encoded.dispose();
					},
				)
				.finally(() => {
					hostCalls.live.delete(deferred);
					hostCalls.pending = Math.max(0, hostCalls.pending - 1);
					if (hostCalls.closed) return;
					hostCalls.refreshDeadline?.();
					hostCalls.onSettled?.();
					// The guest is parked on this promise; nothing advances it until
					// the job queue runs.
					runtime.executePendingJobs();
				});
			return deferred.handle;
		});
		context.setProp(context.global, name, fn);
		fn.dispose();
	};

	asyncBridge("__workflow_agent", async (values) => {
		const prompt = typeof values[0] === "string" ? values[0] : String(values[0] ?? "");
		const parsed = parseJsonRecord(values[1]);
		return host.agent(prompt, parsed);
	});
	asyncBridge("__workflow_iterate", async (values) => host.iterate(parseJsonRecord(values[0])));
	asyncBridge("__workflow_nested", async (values) => {
		const name = typeof values[0] === "string" ? values[0] : "";
		const parsed = values[1] === undefined ? null : parseJsonValue(values[1]);
		return host.nestedWorkflow(name, parsed);
	});

	// Every sync callback returns a handle; the ones with nothing to report hand
	// back `context.undefined`, a static-lifetime handle that must not be disposed.
	const syncBridge = (name: string, operation: (values: unknown[]) => QuickJSHandle): void => {
		const fn = context.newFunction(name, (...handles) => operation(handles.map((handle) => context.dump(handle))));
		context.setProp(context.global, name, fn);
		fn.dispose();
	};

	syncBridge("__workflow_phase", (values) => {
		host.phase(String(values[0] ?? ""));
		return context.undefined;
	});
	syncBridge("__workflow_log", (values) => {
		host.log(String(values[0] ?? ""));
		return context.undefined;
	});
	syncBridge("__workflow_spent", () => context.newNumber(host.budgetSpent()));
	syncBridge("__workflow_remaining", () => context.newNumber(host.budgetRemaining()));

	const total = host.budgetTotal();
	const totalHandle = total === null ? context.null : context.newNumber(total);
	context.setProp(context.global, "__workflow_total", totalHandle);
	if (total !== null) totalHandle.dispose();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
	const parsed = parseJsonValue(value);
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value !== "string") return null;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

/**
 * The guest prelude: the globals a workflow script may use, the barrier
 * semantics of `parallel`/`pipeline`, the 4096-entry caps, and the blocked
 * clock/randomness/host surface. The raw `__workflow_*` bridges are captured
 * into locals and then erased from `globalThis` so a script cannot reach them.
 */
function buildScript(script: string, replay: boolean): string {
	const userSource = JSON.stringify(transformExports(script));
	const clockMessage = replay
		? "Non-deterministic clock access is disabled during workflow replay"
		: "Workflow scripts cannot access wall-clock or random values";
	return `
(() => {
const __workflow_forbidden_now = () => { throw new Error(${JSON.stringify(clockMessage)}); };
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
const __workflow_args_raw = __workflow_args_json;
for (const name of [
  "__workflow_agent",
  "__workflow_iterate",
  "__workflow_nested",
  "__workflow_phase",
  "__workflow_log",
  "__workflow_spent",
  "__workflow_remaining",
  "__workflow_args_json",
]) {
  Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
}
const __workflow_encode = (value) => JSON.stringify(value === undefined ? null : value);
const __workflow_decode = (json) => (typeof json === "string" ? JSON.parse(json) : null);
globalThis.args = __workflow_decode(__workflow_args_raw);
globalThis.agent = async (prompt, options = {}) => __workflow_decode(await __workflow_agent_ref(String(prompt === undefined ? "" : prompt), __workflow_encode(options)));
globalThis.iterate = async (options) => __workflow_decode(await __workflow_iterate_ref(__workflow_encode(options || {})));
globalThis.workflow = async (name, options = null) => __workflow_decode(await __workflow_nested_ref(String(name === undefined ? "" : name), __workflow_encode(options)));
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
globalThis.phase = (title) => { __workflow_phase_ref(String(title === undefined ? "" : title)); };
globalThis.log = (message) => { __workflow_log_ref(String(message === undefined ? "" : message)); };
globalThis.budget = Object.freeze({
  total: __workflow_total,
  spent: () => __workflow_spent_ref(),
  remaining: () => __workflow_remaining_ref(),
});
Object.defineProperty(globalThis, "process", { value: undefined, writable: false, configurable: false });
Object.defineProperty(globalThis, "require", { value: undefined, writable: false, configurable: false });
Object.defineProperty(globalThis, "fetch", { value: undefined, writable: false, configurable: false });
const __workflow_main = Object.getPrototypeOf(async function() {}).constructor(${userSource});
return __workflow_main().then((__workflow_value) => JSON.stringify({
  value: __workflow_value === undefined ? null : __workflow_value,
  meta: globalThis.__workflow_meta || {},
}));
})()
`;
}

/**
 * Strip `export` so the script body is valid inside an AsyncFunction, and route
 * the `meta` declaration into a global the host can read back after the run.
 */
function transformExports(script: string): string {
	return script
		.replace(/^[\t ]*export[\t ]+(?=(?:const|let|var|function|async[\t ]+function|class)\b)/gmu, "")
		.replace(/^[\t ]*(const|let|var)[\t ]+meta[\t ]*=/mu, "$1 meta = globalThis.__workflow_meta =")
		.replace(/^\s*export\s*\{[^}]*\};?\s*$/gmu, "");
}

function clampMemory(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEMORY_LIMIT_MB;
	return Math.max(8, Math.min(256, Math.floor(value)));
}

function clampTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(100, Math.min(600_000, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonSafe(value: unknown): unknown {
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

function normalizeMeta(value: unknown): WorkflowMeta {
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
