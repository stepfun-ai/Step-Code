#!/usr/bin/env node
// Check the Windows installer this pipeline just built, before anything ships it.
//
//   node scripts/verify-win-artifact.mjs [--dir=dist-electron] [--unpacked=<win-unpacked>] [--signed]
//
// --signed: the installer must carry an Authenticode signature (the EV-signed
// release build); without it, it must carry none (the unsigned cross-build).
// This is a structural check usable on any OS; signtool's chain verdict is
// pack-win.cjs's job on the Windows packager.
//
// There is no Windows machine in this pipeline, so the installer can never be run
// here. What can be proven without one is that the bytes are a real PE image and
// that the updater metadata describes the file that exists: a rename, a stale
// latest.yml or a truncated build all look green otherwise.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A short description of the Authenticode signature, or undefined when the PE has
 * no certificate table. Names whoever signed it closely enough to see which
 * certificate was used.
 */
export function authenticodeSignature(bytes) {
	const peOffset = bytes.readUInt32LE(0x3c);
	const magic = bytes.readUInt16LE(peOffset + 24);
	const dataDir = peOffset + 24 + (magic === 0x10b ? 96 : 112);
	const offset = bytes.readUInt32LE(dataDir + 32);
	const size = bytes.readUInt32LE(dataDir + 36);
	if (size === 0) return undefined;
	// WIN_CERTIFICATE: dwLength, wRevision, wCertificateType, then a PKCS#7 DER blob.
	const length = bytes.readUInt32LE(offset);
	const der = bytes.subarray(offset + 8, Math.min(offset + length, offset + size));
	// Certificate names sit in the DER as length-prefixed strings, so read the long
	// printable runs rather than parsing ASN.1: enough to say who signed it.
	const names = [...der.toString("latin1").matchAll(/[\x20-\x7e]{12,120}/gu)]
		.map((match) => match[0])
		.filter((text) => /Developer ID|Apple|DigiCert|StepFun|CN=/u.test(text));
	return `${size} bytes, ${names.slice(0, 2).join(" | ") || "no readable subject"}`;
}

/** The `version` field of a package.json inside an asar archive, without unpacking it. */
function asarPackageVersion(asarPath) {
	const bytes = readFileSync(asarPath);
	// asar layout: uint32 header-pickle size, then a JSON header at offset 16.
	const headerSize = bytes.readUInt32LE(12);
	const header = JSON.parse(bytes.toString("utf8", 16, 16 + headerSize).replace(/\0+$/u, ""));
	const entry = header.files?.["package.json"];
	if (entry?.size === undefined) return undefined;
	// File contents start after the header, padded to a 4-byte boundary.
	const start = 16 + Math.ceil(headerSize / 4) * 4 + Number(entry.offset);
	return JSON.parse(bytes.toString("utf8", start, start + entry.size)).version;
}

/**
 * @param {object} options
 * @param {string} options.dir         where pack-win wrote the installer + metadata
 * @param {string} [options.unpacked]  electron-builder's win-unpacked, to prove the
 *   payload carries the version the metadata advertises
 * @param {boolean} [options.signed]   expect an Authenticode signature instead of none
 * @returns {string[]} every problem found; empty means the artifact is sound.
 */
export function verifyWinArtifact({ dir, unpacked, signed = false, minBytes = 10_000_000 }) {
	const problems = [];
	if (!existsSync(dir)) return [`no directory at ${dir}`];

	const installers = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".exe"));
	if (installers.length !== 1) {
		problems.push(`expected exactly one .exe in ${dir}, found ${installers.length}: ${installers.join(", ") || "none"}`);
		return problems;
	}
	const exeName = installers[0];
	const exePath = join(dir, exeName);
	const bytes = readFileSync(exePath);

	// "MZ" then the PE header link, and machine 0x14c/x86_64 (x64 build) or i386.
	if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ") {
		problems.push(`${exeName} does not start with an MZ header; not a Windows executable`);
	} else {
		const peOffset = bytes.readUInt32LE(0x3c);
		if (bytes.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") {
			problems.push(`${exeName} has no PE signature at 0x${peOffset.toString(16)}`);
		}
	}
	if (bytes.length < minBytes) {
		problems.push(`${exeName} is only ${bytes.length} bytes; a packaged app is tens of MB`);
	}

	// An unsigned build must carry no certificate table: the other certificate in
	// the pipeline is the Apple Developer ID, which Windows does not trust while a
	// naive "is it signed" check would say yes. A signed build must carry one, and
	// it must not be that Apple certificate.
	if (bytes.length >= 0x40 && bytes.toString("latin1", 0, 2) === "MZ") {
		const signature = authenticodeSignature(bytes);
		if (!signed && signature !== undefined) {
			problems.push(
				`${exeName} carries an Authenticode signature (${signature}); this build asks for an unsigned installer, and an Apple certificate is not a Windows identity`,
			);
		}
		if (signed && signature === undefined) {
			problems.push(`${exeName} carries no Authenticode signature; a release installer must be EV-signed`);
		}
		if (signed && signature !== undefined && /Developer ID|Apple/u.test(signature)) {
			problems.push(`${exeName} is signed with an Apple certificate (${signature}), which Windows does not trust`);
		}
	}

	const ymlPath = join(dir, "latest.yml");
	if (!existsSync(ymlPath)) {
		problems.push(`no latest.yml in ${dir}; falcon refuses a channel without updater metadata`);
		return problems;
	}
	const yml = readFileSync(ymlPath, "utf8");
	const field = (pattern) => yml.match(pattern)?.[1];

	// electron-updater resolves these relative to the yml: a stale name is a 404 on
	// the client, never a build failure.
	if (field(/^path:\s*(\S+)$/mu) !== exeName) problems.push(`latest.yml path does not name ${exeName}`);
	for (const url of yml.matchAll(/^\s*-\s*url:\s*(\S+)$/gmu)) {
		if (url[1] !== exeName) problems.push(`latest.yml files[] names ${url[1]}, packaged ${exeName}`);
	}

	const sha512 = createHash("sha512").update(bytes).digest("base64");
	for (const listed of new Set([...yml.matchAll(/sha512:\s*(\S+)/gu)].map((m) => m[1]))) {
		if (listed !== sha512) problems.push(`latest.yml sha512 ${listed.slice(0, 16)}… is not the installer's ${sha512.slice(0, 16)}…`);
	}
	const size = field(/^\s+size:\s*(\d+)$/mu);
	if (size !== undefined && Number(size) !== bytes.length) {
		problems.push(`latest.yml size ${size} is not the installer's ${bytes.length}`);
	}

	// The version in the yml and in the file name have to agree, or the updater
	// advertises a release it never published.
	const version = field(/^version:\s*(\S+)$/mu);
	const named = exeName.match(/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-x64\.exe$/u)?.[1];
	if (version === undefined) problems.push("latest.yml has no version");
	else if (named !== undefined && named !== version) {
		problems.push(`installer name carries ${named}, latest.yml says ${version}`);
	}

	// The installer is assembled from win-unpacked in the same run, so this is the
	// payload it carries. A version mismatch here means the app reports one version
	// and the updater advertises another.
	if (unpacked !== undefined) {
		const asar = join(unpacked, "resources", "app.asar");
		const server = join(unpacked, "resources", "server", "node_modules", "@step-harness", "web", "package.json");
		if (!existsSync(asar)) problems.push(`no resources/app.asar in ${unpacked}`);
		if (!existsSync(server)) problems.push(`no @step-harness/web in ${unpacked}; the packaged app cannot serve its UI`);
		if (existsSync(asar)) {
			const packed = asarPackageVersion(asar);
			if (packed !== version) problems.push(`packaged app is ${packed}, latest.yml says ${version}`);
		}
	}

	// falcon collects through this manifest; a channel pointing at a file that is
	// not there only fails later, on the machine that uploads.
	const manifestPath = join(dir, "channel-artifacts.json");
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		for (const channel of manifest.channels ?? []) {
			if (!existsSync(join(dir, channel.exe ?? ""))) problems.push(`channel ${channel.channelId}: no installer at ${channel.exe}`);
			if (!existsSync(join(dir, channel.latestYml ?? ""))) problems.push(`channel ${channel.channelId}: no updater metadata at ${channel.latestYml}`);
		}
	}

	return problems;
}

function main() {
	const argv = process.argv.slice(2);
	const dirArg = argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
	const dir = dirArg ?? join(repoRoot, "dist-electron");
	const unpacked = argv.find((arg) => arg.startsWith("--unpacked="))?.slice("--unpacked=".length);
	const signed = argv.includes("--signed");
	const problems = verifyWinArtifact({ dir, unpacked: unpacked || undefined, signed });
	if (problems.length > 0) {
		console.error(`Windows installer check failed (${relative(repoRoot, dir) || dir}):`);
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	const exe = readdirSync(dir).find((name) => name.toLowerCase().endsWith(".exe"));
	const signature = signed ? authenticodeSignature(readFileSync(join(dir, exe))) : undefined;
	console.log(
		`Windows installer check passed: ${relative(repoRoot, join(dir, exe))} (${statSync(join(dir, exe)).size} bytes${signature ? `, signed: ${signature}` : ", unsigned"})`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
