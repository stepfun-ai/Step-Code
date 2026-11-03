#!/usr/bin/env node
// Copy the photon-node wasm blob next to the coding-agent build output.
//
// Under pnpm's strict node_modules layout there is no flat
// `../../node_modules/@silvia-odwyer/photon-node/…` path to rely on, so we
// resolve the package from the caller's working directory (the coding-agent
// package, which declares @silvia-odwyer/photon-node as a direct dependency)
// instead of hard-coding a hoisted path. Do NOT reintroduce a flat path or
// node-linker=hoisted to make the old copy work.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const destDir = resolve(process.argv[2] ?? "dist");
// Resolve relative to the current working directory (coding-agent) so pnpm's
// per-package symlink tree is honoured.
const require = createRequire(join(process.cwd(), "package.json"));
const packageJson = require.resolve("@silvia-odwyer/photon-node/package.json");
const wasmPath = join(dirname(packageJson), "photon_rs_bg.wasm");

mkdirSync(destDir, { recursive: true });
copyFileSync(wasmPath, join(destDir, "photon_rs_bg.wasm"));
