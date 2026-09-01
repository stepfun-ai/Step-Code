#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${STEP_RELEASE_BASE_URL:-__STEP_RELEASE_BASE_URL__}"
VERSION="${STEP_VERSION:-latest}"
INSTALL_DIR="${STEP_INSTALL_DIR:-${HOME}/.step-harness/bin}"
AGENT_DIR="${STEP_HARNESS_CODING_AGENT_DIR:-${HOME}/.step-harness/agent}"
WORK_DIR=""
TARGET_ID=""

die() { printf 'step-harness installer: %s\n' "$*" >&2; exit 1; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }
download() {
	if has_cmd curl; then curl -fsSL "$1" -o "$2"; return; fi
	if has_cmd wget; then wget -qO "$2" "$1"; return; fi
	die "curl or wget is required";
}
download_progress() {
	if has_cmd curl; then curl -fL --progress-bar "$1" -o "$2"; return; fi
	if has_cmd wget; then wget --show-progress -O "$2" "$1"; return; fi
	die "curl or wget is required";
}

json_value() {
	awk -F'"' -v section="$1" -v wanted="$2" '
		$0 ~ "\\\"" section "\\\"[[:space:]]*:" { in_section=1; next }
		in_section && /^[[:space:]]*}/ { exit }
		in_section && $2 == wanted { print $4; exit }
	' "$3"
}

json_top_value() {
	awk -F'"' -v wanted="$1" '$0 ~ "\\\"" wanted "\\\"[[:space:]]*:" { print $4; exit }' "$2"
}

normalize_version() {
	local value="$1"
	value="${value#refs/tags/}"
	value="${value#step-v}"
	value="${value#v}"
	[[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid release version: $1"
	printf '%s' "$value"
}

detect_target() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
	case "$os" in
		darwin) os="darwin" ;;
		linux) os="linux" ;;
		*) die "unsupported operating system: $os (use install.ps1 on Windows)" ;;
	esac
	case "$arch" in
		x86_64|amd64) arch="x64" ;;
		aarch64|arm64) arch="arm64" ;;
		*) die "unsupported architecture: $arch" ;;
	esac
	TARGET_ID="${os}-${arch}"
}

verify_checksum() {
	local archive="$1" expected="$2" actual
	[[ -z "$expected" ]] && return 0
	if has_cmd sha256sum; then actual="$(sha256sum "$archive" | awk '{print $1}')"
	elif has_cmd shasum; then actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
	else printf 'warning: no sha256 tool; skipped archive verification\n' >&2; return 0; fi
	[[ "$actual" == "$expected" ]] || die "checksum mismatch (expected $expected, got $actual)"
}

copy_runtime_dir() {
	local source="$1" name="$2" target="${INSTALL_DIR}/${2}"
	[[ -e "${source}/${name}" ]] || return 0
	rm -rf "$target"
	mkdir -p "$target"
	cp -R "${source}/${name}/." "$target/"
}

install_managed_tool() {
	local name="$1" binary="$2" asset="$3" repo="$4" tag_prefix="$5" tool_dir="$AGENT_DIR/bin"
	local target="${tool_dir}/${binary}"
	[[ -x "$target" || -x "${target}.exe" ]] && return 0
	if has_cmd "$binary" || { [[ "$name" == fd ]] && has_cmd fdfind; }; then return 0; fi
	local metadata="${WORK_DIR}/${name}.json" version archive extract found
	if ! download "https://api.github.com/repos/${repo}/releases/latest" "$metadata"; then
		printf 'warning: could not resolve %s; install it manually if unavailable in PATH\n' "$name" >&2
		return 0
	fi
	version="$(awk -F'"' '/"tag_name"[[:space:]]*:/ { print $4; exit }' "$metadata")"
	version="${version#v}"
	archive="${WORK_DIR}/${name}.archive"
	extract="${WORK_DIR}/${name}.extract"
	mkdir -p "$extract" "$tool_dir"
	if ! download_progress "https://github.com/${repo}/releases/download/${tag_prefix}${version}/${asset//VERSION/$version}" "$archive"; then
		printf 'warning: could not download %s; continuing without bundled tool\n' "$name" >&2
		return 0
	fi
	if [[ "$archive" == *.zip ]]; then unzip -q "$archive" -d "$extract" || return 0
	else tar -xzf "$archive" -C "$extract" || return 0; fi
	found="$(find "$extract" -type f -name "$binary" -print -quit)"
	[[ -n "$found" ]] || { printf 'warning: %s archive did not contain %s\n' "$name" "$binary" >&2; return 0; }
	cp "$found" "$target"
	chmod 755 "$target" 2>/dev/null || true
}

install_managed_tools() {
	# These are the same managed paths used by the Pi runtime wrapper. Existing
	# system commands remain valid; missing tools are fetched into Step storage.
	mkdir -p "$AGENT_DIR/bin"
	local fd_asset rg_asset
	if [[ "$TARGET_ID" == darwin-arm64 ]]; then fd_asset='fd-vVERSION-aarch64-apple-darwin.tar.gz'; rg_asset='ripgrep-VERSION-aarch64-apple-darwin.tar.gz'
	elif [[ "$TARGET_ID" == darwin-x64 ]]; then fd_asset='fd-vVERSION-x86_64-apple-darwin.tar.gz'; rg_asset='ripgrep-VERSION-x86_64-apple-darwin.tar.gz'
	elif [[ "$TARGET_ID" == linux-arm64 ]]; then fd_asset='fd-vVERSION-aarch64-unknown-linux-gnu.tar.gz'; rg_asset='ripgrep-VERSION-aarch64-unknown-linux-gnu.tar.gz'
	else fd_asset='fd-vVERSION-x86_64-unknown-linux-gnu.tar.gz'; rg_asset='ripgrep-VERSION-x86_64-unknown-linux-musl.tar.gz'; fi
	install_managed_tool fd fd "$fd_asset" sharkdp/fd v
	install_managed_tool rg rg "$rg_asset" BurntSushi/ripgrep ''
}

main() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--version) [[ $# -gt 1 ]] || die '--version requires a value'; VERSION="$2"; shift 2 ;;
			--install-dir) [[ $# -gt 1 ]] || die '--install-dir requires a value'; INSTALL_DIR="$2"; shift 2 ;;
			-h|--help) printf 'Usage: install.sh [--version <vX.Y.Z|latest>] [--install-dir <path>]\n'; return 0 ;;
			*) die "unknown argument: $1" ;;
		esac
	done
	BASE_URL="${BASE_URL%/}"
	detect_target
	WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/step-harness-install.XXXXXX")"
	trap 'rm -rf "$WORK_DIR"' EXIT
	local manifest="${WORK_DIR}/manifest.json" archive="${WORK_DIR}/release.archive" extract="${WORK_DIR}/extract" binary expected resolved
	if [[ "$VERSION" == latest ]]; then
		download "${BASE_URL}/latest.json" "$manifest"
	else
		VERSION="$(normalize_version "$VERSION")"
		download "${BASE_URL}/${VERSION}/manifest.json" "$manifest"
	fi
	resolved="$(json_top_value version "$manifest")"
	[[ -n "$resolved" ]] || die 'release manifest does not contain version'
	VERSION="$resolved"
	local package_url
	package_url="$(json_value packages "$TARGET_ID" "$manifest")"
	[[ -n "$package_url" ]] || die "manifest does not contain package for ${TARGET_ID}"
	expected="$(json_value checksums "$TARGET_ID" "$manifest")"
	download_progress "$package_url" "$archive"
	verify_checksum "$archive" "$expected"
	mkdir -p "$extract"
	if [[ "$archive" == *.zip ]]; then unzip -q "$archive" -d "$extract"; else tar -xzf "$archive" -C "$extract"; fi
	local binary_name=step
	[[ "$TARGET_ID" == windows-* ]] && binary_name=step.exe
	binary="$(find "$extract" -type f -name "$binary_name" -print -quit)"
	[[ -n "$binary" ]] || die 'release archive does not contain the Step binary'
	# Unix archives use a wrapper directory (step/) for package-manager and
	# archive extraction compatibility; Windows zips place files at the root.
	# Resolve runtime resources relative to the actual archive root in either
	# layout so native helpers and themes are installed consistently.
	local archive_root
	archive_root="$(dirname "$binary")"
	mkdir -p "$INSTALL_DIR"
	local destination="${INSTALL_DIR}/$( [[ "$TARGET_ID" == windows-* ]] && printf step.exe || printf step )"
	local temporary="${destination}.tmp.$$"
	cp "$binary" "$temporary"
	chmod 755 "$temporary" 2>/dev/null || true
	mv -f "$temporary" "$destination"
	for dir in native theme assets export-html docs examples; do copy_runtime_dir "$archive_root" "$dir"; done
	install_managed_tools
	"$destination" --version >/dev/null || die 'installed Step failed its smoke test'
	printf 'installed Step Harness %s to %s\n' "$VERSION" "$destination"
}

main "$@"
