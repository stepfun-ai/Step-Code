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

Workflow execution requires the optional `isolated-vm` native addon to load under the selected Node runtime. A successful install with `--ignore-scripts` alone does not establish that the native addon is built. From the repository root, check that the addon can create an isolate:

```bash
cd packages/coding-agent
node --no-node-snapshot -e 'const vm = require("isolated-vm"); const isolate = new vm.Isolate({ memoryLimit: 16 }); console.log(isolate.createContextSync().evalSync("1 + 1")); isolate.dispose();'
```

The expected result is `2`. If loading fails under Node, inspect the underlying error and install or rebuild the addon for that runtime before using workflows.

The Bun standalone executable cannot host this V8 addon. It therefore does not register the `workflow` tool, `/workflows`, or `/ultraloop`. Suppressing the unsupported-runtime warning does not enable those features; use the Node source entry with a working addon when workflows are required.

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
