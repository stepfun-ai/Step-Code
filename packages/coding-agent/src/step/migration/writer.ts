import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { acquireSettingsLockSync } from "../../core/settings-manager.ts";
import { writeStepConfig } from "../config-toml.ts";
import {
	bytes,
	durableWrite,
	fail,
	hash,
	info,
	inside,
	privateDir,
	safePath,
	syncDir,
	syncFile,
	text,
	tree,
	treeHash,
} from "./filesystem.ts";
import type { Journal, MigrationJournalStore, WriteIntent } from "./journal.ts";
import { configDocument, type MigrationPaths } from "./paths.ts";
import type { PreparedMigration } from "./preview.ts";
import { resourceSnapshot } from "./resources.ts";
import { ruleImpact } from "./rules.ts";
import type { MigrationScope } from "./types.ts";

/** Create owned resource subdirectories, never the host-selected project anchor. */
function resourceDirectory(paths: MigrationPaths, scope: MigrationScope, path: string, restricted = false): void {
	if (scope.kind === "global") {
		privateDir(path, restricted);
		return;
	}
	paths.projectIdentity(scope);
	if (!inside(scope.cwd, path)) fail("invalid-projects");
	let current = scope.cwd;
	for (const part of relative(scope.cwd, path).split(/[\\/]/u).filter(Boolean)) {
		current = join(current, part);
		safePath(current);
		if (!info(current)) mkdirSync(current, { mode: 0o700 });
		safePath(current);
		if (!info(current)?.isDirectory()) fail("unsafe-state-directory");
	}
	paths.projectIdentity(scope);
	if (restricted && process.platform !== "win32" && (Number(info(path)!.mode) & 0o077) !== 0)
		fail("unsafe-state-directory");
}

export function currentHash(path: string, directory = false, limit?: number): string | null {
	if (!info(path)) return null;
	return directory ? treeHash(tree(path)) : hash(bytes(path, false, limit)!);
}

/** The journal callback must durably record intent before any target is made discoverable. */
export function publishResource(
	prepared: PreparedMigration,
	journal: Journal,
	store: MigrationJournalStore,
	paths: MigrationPaths,
	expectedTargetHash = prepared.targetHash,
): WriteIntent {
	if (paths.projectIdentity(prepared.dto.target.scope) !== prepared.projectIdentity) fail("invalid-projects", 409);
	if (prepared.dto.candidate.kind !== "rules")
		return publishPreparedResource(prepared, journal, store, paths, expectedTargetHash);
	const target = prepared.dto.target;
	resourceDirectory(paths, target.scope, dirname(target.path));
	const release = acquireSettingsLockSync(target.path);
	try {
		if (
			ruleImpact(paths, target.scope, target.path, prepared.result).impact.fingerprint !==
			prepared.dto.ruleImpact?.fingerprint
		)
			fail("preview-changed", 409);
		return publishPreparedResource(prepared, journal, store, paths, expectedTargetHash);
	} finally {
		release();
	}
}

function publishPreparedResource(
	prepared: PreparedMigration,
	journal: Journal,
	store: MigrationJournalStore,
	paths: MigrationPaths,
	expectedTargetHash: string | null,
): WriteIntent {
	const dto = prepared.dto;
	if (!prepared.item) fail("invalid-resource");
	if (resourceSnapshot(prepared.item).fingerprint !== prepared.sourceHash) fail("source-changed", 409);
	const path = dto.target.path;
	safePath(path);
	if (dto.candidate.kind === "mcp") {
		resourceDirectory(paths, dto.target.scope, dirname(path));
		const release = acquireSettingsLockSync(path);
		try {
			if (currentHash(path) !== expectedTargetHash) fail("target-changed", 409);
			const document = configDocument(path);
			const servers = document.mcp_servers === undefined ? {} : document.mcp_servers;
			if (!servers || typeof servers !== "object" || Array.isArray(servers)) fail("invalid-target-config");
			if (Object.hasOwn(servers, dto.target.name)) fail("target-conflict", 409);
			const next = { ...document, mcp_servers: { ...servers, [dto.target.name]: prepared.mcp! } };
			const stageRoot = join(dirname(path), ".migration-stage");
			resourceDirectory(paths, dto.target.scope, stageRoot, true);
			const stage = join(stageRoot, randomUUID());
			durableWrite(stage, text(path, true) ?? "");
			// Reuse the product serializer, including comment preservation, inside protected same-volume staging.
			writeStepConfig(stage, next);
			syncFile(stage);
			const intent: WriteIntent = {
				itemId: dto.id,
				path,
				before: expectedTargetHash,
				after: currentHash(stage)!,
				committed: false,
			};
			journal.intents.push(intent);
			store.write(journal);
			if (currentHash(path) !== expectedTargetHash) fail("target-changed", 409);
			if (expectedTargetHash === null) {
				linkSync(stage, path);
				unlinkSync(stage);
			} else renameSync(stage, path);
			if (currentHash(path) !== intent.after) fail("publication-conflict", 409);
			syncDir(dirname(path));
			return intent;
		} finally {
			release();
		}
	}
	const directory = dto.candidate.kind === "skills";
	if (currentHash(path, directory) !== expectedTargetHash) fail("target-changed", 409);
	const stageRoot = join(dto.candidate.kind === "rules" ? dirname(path) : dirname(dirname(path)), ".migration-stage");
	resourceDirectory(paths, dto.target.scope, stageRoot, true);
	const stage = join(stageRoot, randomUUID());
	const intent: WriteIntent = {
		itemId: dto.id,
		path,
		before: expectedTargetHash,
		after: directory ? treeHash(prepared.files) : hash(prepared.result),
		committed: false,
	};
	if (dto.candidate.kind === "rules" && expectedTargetHash !== null) {
		const original = bytes(path)!;
		if (hash(original) !== expectedTargetHash) fail("target-changed", 409);
		intent.backup = randomUUID();
		store.backup(intent.backup, original);
	}
	if (directory) {
		resourceDirectory(paths, dto.target.scope, stage);
		for (const file of prepared.files) {
			const destination = join(stage, file.path);
			resourceDirectory(paths, dto.target.scope, dirname(destination));
			durableWrite(destination, file.data);
		}
		syncDir(stage);
	} else durableWrite(stage, prepared.result);
	journal.intents.push(intent);
	store.write(journal);
	paths.projectIdentity(dto.target.scope);
	resourceDirectory(paths, dto.target.scope, dirname(path));
	if (currentHash(path, directory) !== expectedTargetHash) fail("target-changed", 409);
	if (directory) {
		// Reserve exclusively. Rename can replace only our still-empty reservation, never a pre-existing directory.
		mkdirSync(path, { mode: 0o700 });
		const reserved = info(path)!;
		const now = info(path)!;
		if (now.ino !== reserved.ino || now.dev !== reserved.dev || readdirSync(path).length)
			fail("publication-conflict", 409);
		renameSync(stage, path);
	} else if (expectedTargetHash === null) {
		linkSync(stage, path);
		unlinkSync(stage);
	} else {
		// External editors do not share our lock. Recheck immediately before and after replacement; never retry a conflict.
		if (currentHash(path) !== expectedTargetHash) fail("target-changed", 409);
		renameSync(stage, path);
	}
	syncDir(dirname(path));
	if (currentHash(path, directory) !== intent.after) fail("publication-conflict", 409);
	return intent;
}
