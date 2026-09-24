# Development

See [AGENTS.md](https://github.com/stepfun-ai/step-harness/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/stepfun-ai/step-harness
cd step-harness
npm install
npm run build
```

Run from source with a Node version that satisfies the root `package.json` engines requirement (currently Node 22.19.0 or later):

```bash
NODE_OPTIONS=--no-node-snapshot /path/to/step-harness/step-test.sh
```

The script can be run from any directory. Step keeps the caller's current working directory. It uses tsx and the repository's absolute tsconfig path, so source execution does not depend on built workspace packages. Workflow and subagent children preserve the parent's preload/loader options and inherit its environment, including `TSX_TSCONFIG_PATH` and `NODE_OPTIONS`. Debugger options and parent-only execution modes in `process.execArgv` are not forwarded.

### Workflow runtime

Workflow scripts run in QuickJS compiled to WebAssembly (`src/features/workflow/vm.ts`). The engine ships with the package as a pure-JavaScript dependency, so it needs no native build step and behaves identically under Node and under the standalone executable — the `workflow` tool, `/workflows`, and `/ultraloop` register on every supported runtime.

This replaced the `isolated-vm` native addon, which linked V8's C++ API directly and therefore could only load on a V8 host. The standalone executable is built with Bun and runs on JavaScriptCore, so that addon could never load there: workflows, and with them the ultraloop opt-in that shares the workflow registration gate, were silently missing from every released build while working in a source run on Node.

Two constraints matter when editing the sandbox:

- Keep the `singlefile` QuickJS variant. The default `wasmfile` variant loads its `.wasm` from disk beside its own module, and that path does not exist inside a compiled executable's virtual filesystem.
- Release every handle before disposing the context, and dispose the context before the runtime. Otherwise QuickJS aborts the whole WebAssembly instance on `JS_FreeRuntime`, and because the module is cached process-wide that poisons every later run in the session.

Guest scripts have no access to `process`, `require`, `fetch`, the wall clock, or randomness, and run under a memory cap and a timeout. A single uninterrupted CPU burst longer than the timeout is terminated; time spent waiting on a host call is not counted against it.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.stepcode/agent/step-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
