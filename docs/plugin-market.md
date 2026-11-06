# Plugin market installation (Web and Desktop)

The shared React client installs curated plugins and imports plugin ZIPs through the authenticated loopback Host. This is separate from independent skill imports and from CLI package-manager npm/git support.

## Installation and consent

- Catalog details request `GET /api/v1/settings/plugins/catalog/{catalogId}`. The Host resolves only its packaged catalog, not a path or URL supplied by the browser.
- Imports POST canonical base64 ZIP bytes to `/api/v1/settings/plugins/import`. The first request validates and previews only; it does not write plugin files, start MCP or read credentials.
- Preview reports the plugin identity, resource directories, MCP server names, required environment variable names, external CLI requirement and a SHA-256 fingerprint of the actual files/modes.
- Clicking Install or choosing an import file is the explicit installation action; there is no second browser confirmation dialog. The client silently validates first, then carries `confirmed: true` and the same content fingerprint. Changed content requires a fresh validation/retry. Runtime tool permissions, archive checks and conflict protection are unchanged; this is not a signature or security certification.
- Installation stages files privately under the configured user plugin root, then renames the completed directory. Existing plugins are never overwritten. Failed validation leaves no installation; failed publication cleans its staging directory. Concurrent installations of the same id return 409.
- After files are installed, known CLI dependencies are automatically prepared/verified in a private agent tool directory. Failure preserves the plugin and returns setup-required status, not full CLI readiness. Unknown declarations cannot execute arbitrary installers. See [CLI preparation](plugin-cli-preparation.md).
- A successful Host mutation reconciles MCP connections. Plugin skills and commands become available in new or reloaded sessions; current session resource snapshots are not silently rebuilt during a turn.

## ZIP support

One flat plugin or one wrapper folder is supported, with `step.plugin.json` or the existing Claude-compatible `.claude-plugin/plugin.json` entry. Missing skill entry points/descriptions, command files and malformed MCP declarations are rejected.

Limits: 32 MiB uploaded ZIP, 64 MiB expanded content and 6000 entries. Only stored/deflated regular files are supported. Paths, local/central records and CRC are checked before writing; traversal, duplicate/case-alias names, links, encrypted archives, ZIP64 and unsupported file types are rejected. These checks prevent extraction hazards; they do not inspect instructions or executable code for malicious behavior.

## Portable curated resources

`apps/web/scripts/package-plugin-market.mjs` reads the locally reviewed converted plugin packages and creates `apps/web/resources/plugin-market.json`. It includes declared skills, commands, MCP declarations, associated root scripts/references/assets and root notices. It excludes repository/dependency caches and refuses links or credential-like files. It never executes plugin scripts or downloads dependencies.

The Web build copies this resource beside the compiled Host as `dist/plugin-market.json`; installation does not depend on the developer machine's source path. Catalog ids must map to actual manifest ids. Regenerate explicitly when the curated packages change, and verify the generated resource before distribution. Packaging is not license approval: copyright/component licenses and redistribution permission remain release prerequisites.

## Payload archive is distributed separately

`apps/web/resources/` is generated from the reviewed local collection and is **not committed**. The source collection is ~1.4 GB (45 `.git` directories and whole third-party repositories), so committing the derived payloads would permanently add 119 MB of third-party skill content to history and carry attribution/redistribution obligations.

Instead:

- the repo commits `client/src/features/market/catalog/catalog.json` (metadata, so browsing works);
- the installable payloads ship as a separate archive, restored into `apps/web/resources/`;
- `scripts/copy-market-payload.mjs` copies them into `dist/` and warns when absent;
- without them the market still browses and installation returns a clear 404.

Run the packaging scripts to regenerate. They copy only declared resources, exclude `.git` / `node_modules` / credential-like files, and never execute plugin scripts.

## Management and reference state

Installing, importing, toggling or uninstalling invalidates the client extension projections. Disabled plugins are excluded from the plus/slash reference lists and cannot be trialed. Trial opens a fresh draft with exactly the selected extension reference chip and an empty message body, closes the management overlay and never sends a model request automatically. Uninstall preserves credentials and removes the plugin's own enable/disable preference so a later reinstall is not unexpectedly disabled.

Content-matching curated installations appear under Market; edited or linked installations are Custom. Source grouping is never a permission verdict. DWS/Lark/WeCom have fixed private CLI preparation recipes; unsupported or failed dependencies explain the reason and offer preparation/first-use setup guidance. Environment variables and OAuth remain user configuration; no authentication is automatically granted and no third-party service is presumed operational.

See [OpenAPI](../apps/web/openapi.yaml), [Web Host](stepcode-web.md), and the isolated tests in `apps/web/test/plugin-market.test.ts` and `packages/coding-agent/test/step-plugin-install.test.ts`.
