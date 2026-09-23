/**
 * QuickJS (WebAssembly) workflow executor.
 *
 * `runInIsolatedVm` links V8's C++ API through the `isolated-vm` native addon,
 * so it can only load on a V8 host. The shipped executable is built with
 * `bun build --compile`, whose engine is JavaScriptCore, and there the addon can
 * never load however it is installed — which silently took the whole workflow
 * tool (and with it the ultraloop opt-in, since both share one registration
 * gate) out of every released build. This module is the sandbox for that host:
 * QuickJS compiled to WebAssembly runs on V8 and JavaScriptCore alike.
 *
 * It implements the same contract as `runInIsolatedVm` — identical signature,
 * identical guest globals, identical limits — so `WorkflowRuntime.vmExecutor`
 * can swap one for the other without the rest of the workflow stack noticing.
 * The engine-independent pieces (script-size cap, memory/timeout clamps,
 * `export` rewriting, `meta` normalization, JSON-safe argument copying) are
 * imported from `vm.ts` rather than reimplemented, so the two executors cannot
 * drift apart on those.
 *
 * Two deliberate choices:
 *
 *   - The `singlefile` QuickJS variant is mandatory. The default `wasmfile`
 *     variant loads `emscripten-module.wasm` from disk next to its module,
 *     which does not exist inside a compiled executable's virtual filesystem
 *     (`ENOENT /$bunfs/root/emscripten-module.wasm`). `singlefile` inlines the
 *     module instead.
 *   - Everything crossing the boundary is JSON text. QuickJS lives in its own
 *     WebAssembly memory, so a guest value is never a host object reference;
 *     encoding explicitly keeps the copy semantics of the `isolated-vm` path
 *     (`ExternalCopy` / `copy: true`) visible instead of implicit. Values the VM
 *     contract already excludes — functions, symbols — are not transferable
 *     either way.
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core";
import {
	clampMemory,
	clampTimeout,
	normalizeMeta,
	toJsonSafe,
	transformExports,
	WORKFLOW_MAX_SCRIPT_BYTES,
	type WorkflowVmHost,
	type WorkflowVmOptions,
	type WorkflowVmResult,
} from "./vm.ts";

/**
 * The WebAssembly module is process-wide and costs ~30ms to instantiate, so it
 * is built once on first use. Loading is dynamic to keep the ~3MB inlined module
 * out of a session that never runs a workflow, and off the V8 path entirely.
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

/** Whether this runtime can execute workflows through QuickJS. Always true; the module ships with the package. */
export function isQuickJsVmAvailable(): boolean {
	return true;
}

/** Mirrors the pending-call bookkeeping in `vm.ts` so a slow agent cannot trip the script timeout. */
interface HostCallTracker {
	pending: number;
	onSettled?: () => void;
}

/**
 * Run a workflow script inside a QuickJS WebAssembly context.
 *
 * Signature-compatible with `runInIsolatedVm`; see that function for the shared
 * contract.
 */
export async function runInQuickJs(
	script: string,
	args: unknown,
	host: WorkflowVmHost,
	options: WorkflowVmOptions = {},
): Promise<WorkflowVmResult> {
	const sourceBytes = Buffer.byteLength(script, "utf8");
	if (sourceBytes > WORKFLOW_MAX_SCRIPT_BYTES) {
		throw new Error(`Workflow script exceeds ${WORKFLOW_MAX_SCRIPT_BYTES} bytes`);
	}
	const quickjs = await loadQuickJsModule();
	const timeoutMs = clampTimeout(options.timeoutMs);
	const runtime = quickjs.newRuntime();
	runtime.setMemoryLimit(clampMemory(options.memoryLimitMb) * 1024 * 1024);

	const hostCalls: HostCallTracker = { pending: 0 };
	// Refreshed by armTimeout(); the interrupt handler reads it to stop a
	// CPU-bound guest loop, which no host-side timer can preempt.
	let interruptDeadline = Date.now() + timeoutMs;
	let timedOut = false;
	runtime.setInterruptHandler(() => {
		if (hostCalls.pending > 0) return false;
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
		interruptDeadline = Date.now() + timeoutMs;
		timeout = setTimeout(checkTimeout, timeoutMs);
	};
	hostCalls.onSettled = (): void => {
		if (hostCalls.pending === 0) armTimeout();
	};

	// Every handle created here must be released before `context.dispose()`, or
	// QuickJS aborts the whole WebAssembly instance on `JS_FreeRuntime`
	// ("Assertion failed: list_empty(&rt->gc_obj_list)") and poisons the cached
	// module for every later run. Disposal order matters too: context first,
	// runtime second.
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
		// A rejected timeoutPromise with no other listener would surface as an
		// unhandled rejection once this frame unwinds.
		timeoutPromise.catch(() => {});
		runtime.removeInterruptHandler();
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
	// toJsonSafe keeps this byte-identical to what the isolated-vm path copies in,
	// including its treatment of values JSON has no representation for.
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
 * when the failure was our own interrupt, so a timeout reads the same as it does
 * on the isolated-vm path instead of surfacing QuickJS's "interrupted".
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
			hostCalls.pending += 1;
			void Promise.resolve()
				.then(() => operation(values))
				.then(
					(result) => {
						const encoded = context.newString(JSON.stringify(toJsonSafe(result)) ?? "null");
						deferred.resolve(encoded);
						encoded.dispose();
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						const encoded = context.newError(message);
						deferred.reject(encoded);
						encoded.dispose();
					},
				)
				.finally(() => {
					hostCalls.pending = Math.max(0, hostCalls.pending - 1);
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
 * Guest prelude. Mirrors `buildScript` in `vm.ts`: same globals, same barrier
 * semantics for `parallel`/`pipeline`, same 4096-entry caps, same blocked
 * clock/randomness/host surface. The only difference is the bridge — plain
 * function calls exchanging JSON text instead of `isolated-vm` references.
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
