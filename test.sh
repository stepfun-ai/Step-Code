#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
cd "$script_dir"

# Tests import workspace packages through their package entrypoints, which
# point at ignored dist/ files. Build those outputs on the first test run in a
# fresh worktree; established worktrees keep the existing fast path.
build_outputs=(
	"packages/tui/dist/index.js"
	"packages/telemetry/dist/index.js"
	"packages/providers/dist/index.js"
	"packages/agent-core/dist/index.js"
	"packages/config/dist/index.js"
	"packages/coding-agent/dist/index.js"
	"apps/cli/dist/main.js"
)
needs_build=false
for output in "${build_outputs[@]}"; do
	if [[ ! -f "$output" ]]; then
		needs_build=true
		break
	fi
done

if [[ "$needs_build" == true ]]; then
	echo "Workspace build output is missing; running the offline build before tests."
	pnpm run build:offline
fi

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/step-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.step-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/step-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.step-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"STEP_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
env -i "${test_env[@]}" npm test
