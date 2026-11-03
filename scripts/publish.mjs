#!/usr/bin/env node

console.error(
	"npm package publishing is disabled for StepCode; release standalone binaries with npm run release:bundle.",
);
process.exitCode = 1;
