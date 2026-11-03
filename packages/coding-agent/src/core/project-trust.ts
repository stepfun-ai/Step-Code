import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	/** Project resource directory name. Defaults to Pi's configured value. */
	configDirName?: string;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	/**
	 * Ask even when the directory ships no project config.
	 *
	 * Two different questions share this resolver. A session asks "may I read
	 * what is here", and that matters for any directory with files in it, because
	 * a file can be written to instruct the model. `step package` asks "may I
	 * write project config here", which is moot until project config exists —
	 * refusing there would make it impossible to create the first one. Session
	 * callers set this; the package CLI does not.
	 */
	alwaysAsk?: boolean;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

function formatProjectTrustPrompt(cwd: string, configDirName: string): string {
	// Two risks, and the second is why this is asked for every directory rather
	// than only those shipping a config: whatever is in these files reaches the
	// model, and text in a file can be written to give the model instructions.
	return [
		"Do you trust the contents of this folder?",
		cwd,
		"",
		`Working with untrusted contents carries a risk of prompt injection: text in a file can be written to instruct ${APP_NAME}.`,
		`Trusting also allows ${APP_NAME} to load ${configDirName} settings and resources, install missing project packages, and execute project extensions.`,
	].join("\n");
}

/**
 * Raised when the user answers "no" to the startup trust prompt.
 *
 * Declining has to end the launch. The prompt warns that the directory's files
 * could carry instructions for the model; continuing in an untrusted session
 * would still read those files, so "no" would protect nothing and the warning
 * would be theatre. `main` catches this and exits quietly.
 */
export class ProjectTrustDeclinedError extends Error {
	readonly cwd: string;

	constructor(cwd: string) {
		super(`Project trust declined for ${cwd}`);
		this.name = "ProjectTrustDeclinedError";
		this.cwd = cwd;
	}
}

const TRUST_YES_LABEL = "Yes, continue";
const TRUST_NO_LABEL = "No, quit";

/**
 * Two answers, matching what the other agent CLIs ask.
 *
 * The per-session and parent-folder variants remain on the `/trust` command,
 * where the user has gone looking for them; offering five branches to someone
 * who has just launched in a new folder asks them to make a policy decision
 * before they have a question.
 */
async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
	configDirName: string,
): Promise<ProjectTrustOption | undefined> {
	const selected = await ctx.ui.select(formatProjectTrustPrompt(cwd, configDirName), [
		TRUST_YES_LABEL,
		TRUST_NO_LABEL,
	]);
	if (selected !== TRUST_YES_LABEL) return undefined;
	return getProjectTrustOptions(cwd).find((option) => option.trusted);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	const configDirName = options.configDirName?.trim() || CONFIG_DIR_NAME;
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!options.alwaysAsk && !hasTrustRequiringProjectResources(options.cwd, configDirName)) {
		return true;
	}
	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext, configDirName);
	if (selected === undefined) {
		// "No, quit" and Escape are the same answer. Escape used to drop the user
		// into an untrusted session, which looked like the prompt had been skipped.
		if (options.alwaysAsk) throw new ProjectTrustDeclinedError(options.cwd);
		return false;
	}
	saveProjectTrustPromptResult(options.trustStore, selected);
	return selected.trusted;
}
