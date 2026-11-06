# Skills and connectors in Web and Desktop

The shared client now uses actual installation/import APIs for skills and editable suggestions for connector configuration. These are distinct operations: copying a skill does not execute its instructions; saving MCP configuration may cause the Host to start/connect that service.

## Skills

- Current catalog: 36 skill roots from the supplied local collection. Old OpenTUI is not presented as a skill; Cangjie uses its current root `SKILL.md`. Six additional local design skills are included without inventing upstream certification or download statistics.
- `GET /api/v1/settings/skills/catalog/{catalogId}` previews bundled resources. `POST /api/v1/settings/skills` with `catalogId`, `confirmed: true` and matching `fingerprint` installs them to the configured user agent skill directory.
- `POST /api/v1/settings/skills/upload` accepts canonical base64 bytes and `format: markdown|zip`. Markdown represents a root `SKILL.md`; ZIP/.skill archives may wrap one skill in one directory. First request validates only; the client immediately installs using the same fingerprint after the explicit Install click or file selection, without a second confirmation dialog.
- Valid YAML `name` and non-empty `description` are required. Names must be portable directory/token names. Limits: 32 MiB upload, 128 MiB expanded resources, 16000 entries, and 512 KiB root `SKILL.md`. The shared archive checks reject traversal, aliases/duplicates, links, encryption, ZIP64, bad CRC/records and oversized content.
- Installation uses private staging and stale-recoverable locks, never overwrites an existing skill, and does not execute scripts. Skills become available in new or reloaded sessions. Disable and delete continue to use the existing user-scope resource settings.
- `catalogId` in the skill list is present only when actual installed resources match a bundled package. Same name alone does not prove catalog provenance. Existing valid SkillHub receipts remain display metadata, not trust decisions.

`apps/web/scripts/package-skill-market.mjs` builds the portable resource and updates catalog documents/metadata. It preserves required scripts, references, templates, supporting files and referenced libraries. It explicitly logs excluded repository caches/unrelated samples. The Mermaid distribution copy has normalized YAML to remove duplicate fields; original local packages are unchanged. The build copies `resources/skill-market.json` beside the compiled Host.

The payload archive is **not committed**; see [Payload archive](plugin-market.md#payload-archive-is-distributed-separately). Without it the market browses and installation reports a clear 404.

## Connectors

- Fifteen catalog entries contain evidence-backed configuration suggestions derived from supplied README/server manifests. `package-connector-templates.mjs` updates these suggestions; it never registers or launches MCP.
- Configure opens the existing MCP editor with an initial name/configuration. Developer-facing source/evidence text is not shown in the editor header. Form and JSON tabs remain editable. Opening a template is read-only; save requires confirmation of local execution/network/data-access risks and uses the existing authenticated MCP endpoint.
- Explorer/Excel need an explicit workspace/workbook directory; Unreal needs its local MCP Python directory. Reserved `<WORKSPACE_DIR>` and `<UNREAL_MCP_PYTHON_DIR>` markers are rejected in both the client and the new-declaration Host parser until replaced.
- CLI programs, Docker, editor addons, applications and authentication must be configured separately. A saved declaration is not a claim that the remote service is connected. OAuth/bearer/header settings retain the existing runtime semantics; authorization is never automatically granted.
- User-owned connector menus expose trial and delete; plugin-provided connectors expose trial but are removed with their owning plugin. Disabled resources cannot be trialed or picked through the composer. Trial opens an unsent draft with one reference chip (using the actual installed skill/plugin/server identity), leaves the message body empty and exits settings. It never prefills explanatory text or automatically sends a request.

## Management and verification

Plugin-provided source groups start collapsed and can be expanded using native keyboard-accessible disclosures. Successful skill/MCP changes invalidate all extension projections. Catalog rows use configured server names to reflect installation; matching local connector rows are not duplicated. Error and loading states remain visible.

Tests isolate filesystem mutations under scratch HOME and stub browser APIs. They validate installation/metadata/control flows, not third-party model output quality, license clearance, authenticated external services or all operating systems. Telemetry and P2 automated intake/testing are outside this work.

See [OpenAPI](../apps/web/openapi.yaml) and [Plugin installation](plugin-market.md).
