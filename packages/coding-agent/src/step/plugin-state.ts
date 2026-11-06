import type { StepConfigDocument } from "./config-toml.ts";

/** Plugin-level gate wins over individual contribution preferences. */
export function isStepPluginEnabled(id: string, document: StepConfigDocument): boolean {
	if (document.plugins === undefined) return true;
	const settings: unknown = document.plugins;
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
	const value: unknown = Object.hasOwn(settings, id) ? (settings as Record<string, unknown>)[id] : undefined;
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const enabled = (value as Record<string, unknown>).enabled;
	return enabled === undefined || enabled === true;
}
