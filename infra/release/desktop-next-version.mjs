#!/usr/bin/env node

/** Compute the next StepCode Desktop release tag (`desktop-vX.Y.Z`). */

export const DESKTOP_BUMP_KINDS = ["patch", "minor", "major"];

export const DESKTOP_TAG_PREFIX = "desktop-v";

/** The first Desktop release, whatever bump is asked for: there is nothing to bump from. */
export const DESKTOP_FIRST_VERSION = { major: 0, minor: 1, patch: 0 };

export function parseDesktopReleaseTag(tag) {
	const match = /^desktop-v(\d+)\.(\d+)\.(\d+)$/u.exec(String(tag).trim());
	if (!match) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatDesktopReleaseTag(version) {
	return `${DESKTOP_TAG_PREFIX}${version.major}.${version.minor}.${version.patch}`;
}

function compareVersions(left, right) {
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Highest existing Desktop tag, or `null` when none exists yet. */
export function selectLatestDesktopVersion(tags) {
	let latest = null;
	for (const tag of tags) {
		const version = parseDesktopReleaseTag(tag);
		if (version && (!latest || compareVersions(version, latest) > 0)) latest = version;
	}
	return latest;
}

export function bumpDesktopVersion(version, bump) {
	switch (bump) {
		case "major":
			return { major: version.major + 1, minor: 0, patch: 0 };
		case "minor":
			return { major: version.major, minor: version.minor + 1, patch: 0 };
		case "patch":
			return { major: version.major, minor: version.minor, patch: version.patch + 1 };
		default:
			throw new Error(`unsupported bump '${bump}'; expected ${DESKTOP_BUMP_KINDS.join(", ")}`);
	}
}

export function computeNextDesktopTag({ tags, bump }) {
	if (!DESKTOP_BUMP_KINDS.includes(bump)) {
		throw new Error(`unsupported bump '${bump}'; expected ${DESKTOP_BUMP_KINDS.join(", ")}`);
	}
	const latest = selectLatestDesktopVersion(tags);
	if (!latest) return { latestTag: null, nextTag: formatDesktopReleaseTag(DESKTOP_FIRST_VERSION) };
	return {
		latestTag: formatDesktopReleaseTag(latest),
		nextTag: formatDesktopReleaseTag(bumpDesktopVersion(latest, bump)),
	};
}
