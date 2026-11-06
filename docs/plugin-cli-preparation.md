# Plugin CLI preparation and first-use setup

Plugin-file installation, executable readiness and service authorization are separate outcomes. The Web/Desktop plugin installation response now includes optional `dependency` state rather than always telling the user to install the CLI separately.

## Automatic preparation

The coding-agent preparer uses fixed, evidence-backed recipes:

| Command | Package | Preparation | First use |
| --- | --- | --- | --- |
| dws | dingtalk-workspace-cli@1.0.66 | npm with scripts ignored, then fixed install.js with verified DWS_NO_SKILLS=1 binary-only guard | dws auth login |
| lark-cli | @larksuite/cli@1.0.98 | npm with scripts ignored, then fixed scripts/install.js binary installer | lark-cli auth login |
| wecom-cli | @wecom/cli@1.3.4 | npm platform package binaries, no lifecycle execution | wecom-cli auth init |

macOS/Linux automatic private preparation is supported. Existing known CLIs are reused after a bounded version probe. Unknown commands and unsupported installers/platforms do not execute a manifest-provided shell command; they return `setup_required` with a safe reason. gh/glab have fixed auth guidance and can reuse existing installations; other CLIs retain manual setup.

npm writes only under `<agentDir>/tools/plugin-cli`, using isolated empty user/global npm config, a private cache, explicit public HTTPS registry and ignored lifecycle scripts. The installer subprocess environment includes only runtime/OS basics and no model/API/npm credentials. Only fixed binary installer paths may run; DWS's binary-only guard must exist, so installation cannot write other agents' skills. Output is not propagated as raw logs or returned errors. Installers and version probes are time-bounded.

After verification, the versioned prefix is published and a managed launcher is placed in `<agentDir>/bin`, which the existing shell tool environment already uses. The Host also adds this directory to its process-local PATH so new embedded terminals/MCP children can resolve prepared commands; this does not edit the user's global environment or shell profiles. No sudo, global npm install, shell-profile or system PATH edits occur. User-owned executables are never overwritten. Verified private caches can repair a missing launcher without another download. Plugins and shared CLIs have separate lifecycles: uninstalling a plugin does not delete its shared CLI or credentials.

## API and UI

- Catalog/plugin ZIP installation returns its usual preview/result plus `dependency` when a CLI is declared. Files remain installed if executable preparation fails; that result must not be presented as full CLI readiness.
- `POST /api/v1/settings/plugins/{id}/prepare` retries preparation for an existing user plugin. It requires normal Host authentication, not a second confirmation dialog.
- `GET /api/v1/settings/plugins` reports lightweight executable presence and first-use guidance; it never performs authentication checks or reads credentials. The built-in StepPage preparation path remains unchanged.
- States: `ready` (existing CLI), `installed` (automatic preparation verified), `setup_required` (safe failure/manual reason). Reason codes include missing npm, unsupported recipe/platform, timeout, installer/verification failure and file conflict.
- Success feedback distinguishes automatic CLI installation from plugin copying. Unavailable CLI feedback is neutral, explains the reason and says first-use setup is required. Management/detail UI retains the setup hint, a copyable fixed auth command and a Prepare CLI action when needed.

`firstUseConfiguration` is guidance, not a claim that the user is currently unauthenticated. OAuth/login and optional environment-variable configuration remain user-owned; the preparer never logs in automatically, copies secrets or grants authorization. The user may already have completed setup and can proceed.

## Evidence and validation limits

Recipes were checked against the supplied DWS npm template/README/CHANGELOG, Lark package/install script and WeCom package/bin wrapper. Tests inject execution and isolate HOME for unknown-command, existing CLI, private installation, guard, timeout, conflict and cache-repair cases. Real DWS, Lark and WeCom scratch-HOME npm/binary installations and version probes passed; DWS cache/launcher recovery also passed. Scratch directories were removed. This does not certify every external service, authorization flow, platform or license for redistribution.

See [Plugin market](plugin-market.md) and [OpenAPI](../apps/web/openapi.yaml).
