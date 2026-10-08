# StepCode

StepCode is a terminal coding agent developed by StepFun.

## Install

Published to the StepFun internal npm registry. With that registry configured
in `~/.npmrc`:

```bash
npm install -g @stepfun/stepcode
step
```

Requires Node.js 18 or newer to run the launcher. npm installs one prebuilt
platform package (`@stepfun/stepcode-<os>-<cpu>`) as an optional dependency;
do not install with `--omit=optional`.

Supported platforms: macOS (arm64, x64), Linux glibc (arm64, x64), Windows
(arm64, x64).

## Update

```bash
npm install -g @stepfun/stepcode@latest
```

`step update` does not modify npm-managed installations.

## Standalone installer

```bash
curl -fsSL https://static-openapi.stepfun.com/stepcode/install.sh | bash
```

```powershell
irm https://static-openapi.stepfun.com/stepcode/install.ps1 | iex
```
