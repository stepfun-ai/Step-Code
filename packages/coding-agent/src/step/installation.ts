import { readGlobalStepConfig } from "./config-toml.ts";
import { resolveStepMcpEnvironment } from "./mcp-environment.ts";
import {
	defaultStepMarketplacesDir,
	defaultStepPluginsDir,
	ensureBuiltinPluginsInstalled,
	listStepPluginDirectories,
	readStepPluginManifest,
} from "./plugins.ts";
import { ensureStepShellPath } from "./shell-path.ts";
import { ensureStepPageReady, isManagedStepPageCommand } from "./steppage-provision.ts";

/** Used by installers and the new binary after an update; failures remain warnings. */
export async function prepareStepInstallation(
	input: { env?: NodeJS.ProcessEnv; executablePath?: string } = {},
): Promise<string[]> {
	const env = input.env ?? process.env;
	const warnings = await ensureStepShellPath(input);
	const pluginsDir = defaultStepPluginsDir(env);
	const preinstalled = await ensureBuiltinPluginsInstalled({
		pluginsDir,
		marketplacesDir: defaultStepMarketplacesDir(env),
	});
	warnings.push(...preinstalled.warnings);
	const globalServer = readGlobalStepConfig(env).mcp_servers?.steppage__steppage;
	if (globalServer?.enabled === false) return warnings;
	for (const directory of await listStepPluginDirectories(pluginsDir)) {
		const { manifest } = await readStepPluginManifest(directory);
		const declared = manifest?.mcpServers;
		if (manifest?.id !== "steppage" || !declared || typeof declared === "string") continue;
		const builtinServer = declared.steppage;
		if (!builtinServer || typeof builtinServer !== "object" || Array.isArray(builtinServer)) continue;
		const server = globalServer ?? builtinServer;
		if (!server || typeof server !== "object" || Array.isArray(server)) continue;
		const declaration = server as Record<string, unknown>;
		if (
			declaration.enabled === false ||
			!isManagedStepPageCommand(declaration, manifest.provision) ||
			!isManagedStepPageCommand(builtinServer as Record<string, unknown>, manifest.provision)
		)
			continue;
		const declaredEnv =
			declaration.env && typeof declaration.env === "object" && !Array.isArray(declaration.env)
				? Object.fromEntries(
						Object.entries(declaration.env).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					)
				: undefined;
		const result = await ensureStepPageReady({ env: { ...env, ...resolveStepMcpEnvironment(declaredEnv, { env }) } });
		if (result.error) warnings.push(result.error);
	}
	return warnings;
}
