export interface DirectoryPickOptions {
	readonly title?: string;
	readonly defaultPath?: string;
	/** Resource selection must never become the next-launch workspace. */
	readonly purpose: "workspace" | "resource";
}

export function parseDirectoryPickOptions(raw: unknown): DirectoryPickOptions {
	if (raw === undefined || raw === null) return { purpose: "workspace" };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid directory picker options");
	const input = raw as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["title", "defaultPath", "purpose"].includes(key)))
		throw new Error("Invalid directory picker options");
	for (const field of ["title", "defaultPath"] as const) {
		const value = input[field];
		if (value !== undefined && (typeof value !== "string" || value.length > 4096 || value.includes("\0")))
			throw new Error("Invalid directory picker options");
	}
	if (input.purpose !== undefined && input.purpose !== "workspace" && input.purpose !== "resource")
		throw new Error("Invalid directory picker purpose");
	return {
		purpose: input.purpose === "resource" ? "resource" : "workspace",
		...(typeof input.title === "string" ? { title: input.title } : {}),
		...(typeof input.defaultPath === "string" ? { defaultPath: input.defaultPath } : {}),
	};
}

export function recordDirectoryPick(
	options: DirectoryPickOptions,
	path: string | null,
	recordWorkspace: (path: string) => void,
): string | null {
	if (path !== null && options.purpose === "workspace") recordWorkspace(path);
	return path;
}
