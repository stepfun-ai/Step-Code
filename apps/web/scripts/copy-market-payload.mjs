/**
 * Copy the market payload archives beside the compiled Host.
 *
 * `apps/web/resources/` is generated from the reviewed local collection and is
 * distributed as a separate archive rather than committed, so a fresh checkout
 * has no payloads. Browsing still works from the committed catalog.json; only
 * installation needs these files. Missing payloads are reported, not fatal.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = join(webRoot, "dist");
const payloads = ["plugin-market.json", "skill-market.json"];

await mkdir(dist, { recursive: true });
const missing = [];
for (const name of payloads) {
	const source = join(webRoot, "resources", name);
	if (!existsSync(source)) {
		missing.push(name);
		continue;
	}
	await copyFile(source, join(dist, name));
}
if (missing.length > 0)
	console.warn(
		`[market] payload archive not found: ${missing.join(", ")}. The market can be browsed but plugins/skills cannot be installed until resources/ is restored (see docs/plugin-market.md).`,
	);
