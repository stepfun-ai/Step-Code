/** Local references are presentation candidates, never authority to read a file. */
export function localFileReference(value: string): string | undefined {
	if (!value || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return;
	let path: string;
	try {
		if (/^file:/i.test(value)) {
			const url = new URL(value);
			if (url.hostname || url.search) return;
			path = decodeURIComponent(url.pathname);
		} else {
			if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
			path = decodeURIComponent(value.split("#", 1)[0]);
		}
	} catch {
		return;
	}
	path = path.replace(/^\/([a-z]:[\\/])/i, "$1").replace(/:\d+(?::\d+)?$/, "");
	if (/[\u0000-\u001f<>:"|?*]/u.test(path.replace(/^[a-z]:/i, "")) || /^[\\/]{2}/.test(path)) return;
	if (
		/^(?:[a-z]:[\\/]|\/|\.\.?[\\/])/i.test(path) ||
		/^[^:/\\]+\.[a-z\d]+$/i.test(path) ||
		/^[^:]+[\\/][^:]+\.[a-z\d]+$/i.test(path)
	)
		return path;
}

function normalizedParts(path: string): string[] | undefined {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return;
			parts.pop();
		} else parts.push(part);
	}
	return parts;
}

/** Lexical client guard only; the host still checks real paths and symlinks. */
export function workspaceFileReference(cwd: string, value: string, sourcePath = ""): string | undefined {
	const local = localFileReference(value);
	if (!cwd || !local) return;
	return workspaceFilePath(cwd, local, sourcePath);
}

export type ResolvedFileReference =
	| { readonly scope: "workspace"; readonly path: string }
	| { readonly scope: "local"; readonly path: string };

/**
 * Resolve a message reference for the preview: inside the workspace as a
 * relative path, otherwise — when the reference itself (or the previewed file
 * it sits in, for links inside an outside file) names an absolute location —
 * as a local file the host reads by absolute path. Relative references that
 * leave the workspace stay unresolved, exactly as before.
 */
export function resolveFileReference(cwd: string, value: string, sourcePath = ""): ResolvedFileReference | undefined {
	const local = localFileReference(value);
	if (!cwd || !local) return;
	const reference = local.replace(/\\/g, "/");
	const source = sourcePath.replace(/\\/g, "/");
	const sourceAbsolute = /^[a-z]:\//i.test(source) || source.startsWith("/");
	// An absolute source file (a preview outside the workspace) resolves relative
	// links against its own directory, never against the workspace root —
	// workspaceFilePath would read that as a path under the root instead.
	const inside = sourceAbsolute ? undefined : workspaceFilePath(cwd, local, sourcePath);
	if (inside) return { scope: "workspace", path: inside };
	const referenceAbsolute = /^[a-z]:\//i.test(reference) || reference.startsWith("/");
	if (!referenceAbsolute && !sourceAbsolute) return;
	const spelled = referenceAbsolute ? reference : `${source.slice(0, source.lastIndexOf("/"))}/${reference}`;
	// The reference's spelling decides which kind of host it can exist on.
	if (/^[a-z]:\//i.test(spelled) !== /^[a-z]:\//i.test(cwd.replace(/\\/g, "/"))) return;
	const parts = normalizedParts(spelled);
	if (!parts) return;
	const absolute = /^[a-z]:$/i.test(parts[0] ?? "")
		? `${parts[0]}/${parts.slice(1).join("/")}`
		: `/${parts.join("/")}`;
	// A resolved location that lands back inside the workspace stays a workspace path.
	const asInside = workspaceFilePath(cwd, absolute);
	if (asInside) return { scope: "workspace", path: asInside };
	return { scope: "local", path: absolute };
}

/** Structured tool paths are already literal filenames, not encoded Markdown URLs. */
export function workspaceFilePath(cwd: string, local: string, sourcePath = ""): string | undefined {
	if (!cwd || !local || /[\u0000-\u001f]/u.test(local) || /^[\\/]{2}/.test(local)) return;
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = local.replace(/\\/g, "/");
	const windows = /^[a-z]:\//i.test(root);
	const rootParts = normalizedParts(root);
	if (!rootParts) return;
	const absolute = /^[a-z]:\//i.test(path) || path.startsWith("/");
	const parts = normalizedParts(absolute ? path : `${root}/${sourcePath.split("/").slice(0, -1).join("/")}/${path}`);
	if (!parts || parts.length <= rootParts.length) return;
	if (absolute && /^[a-z]:\//i.test(path) !== windows) return;
	for (let index = 0; index < rootParts.length; index++) {
		const left = parts[index];
		const right = rootParts[index];
		if (windows ? left?.toLowerCase() !== right.toLowerCase() : left !== right) return;
	}
	return parts.slice(rootParts.length).join("/");
}

export type ArtifactKind =
	| "website"
	| "image"
	| "document"
	| "spreadsheet"
	| "presentation"
	| "audio"
	| "video"
	| "file";

export function artifactKind(path: string): ArtifactKind {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	if (["html", "htm"].includes(extension)) return "website";
	if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "ico"].includes(extension)) return "image";
	if (["pdf", "docx", "doc", "md", "mdx", "txt", "rtf"].includes(extension)) return "document";
	if (["xlsx", "xls", "csv", "tsv"].includes(extension)) return "spreadsheet";
	if (["pptx", "ppt"].includes(extension)) return "presentation";
	if (["wav", "mp3", "ogg", "flac", "m4a"].includes(extension)) return "audio";
	if (["mp4", "webm", "mov"].includes(extension)) return "video";
	return "file";
}
