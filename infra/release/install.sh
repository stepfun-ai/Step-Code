#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${STEP_RELEASE_BASE_URL:-__STEP_RELEASE_BASE_URL__}"
VERSION="${STEP_VERSION:-latest}"
INSTALL_DIR="${STEP_INSTALL_DIR:-${HOME}/.stepcode/bin}"
AGENT_DIR="${STEP_CODING_AGENT_DIR:-${HOME}/.stepcode/agent}"
WORK_DIR=""
TARGET_ID=""

die() { printf 'stepcode installer: %s\n' "$*" >&2; exit 1; }
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
	local name="$1" binary="$2" asset="$3" repo="$4" tag_prefix="$5" bundled_root="$6" tool_dir="$AGENT_DIR/bin"
	local target="${tool_dir}/${binary}"
	[[ -x "$target" || -x "${target}.exe" ]] && return 0
	if has_cmd "$binary" || { [[ "$name" == fd ]] && has_cmd fdfind; }; then return 0; fi
	# Prefer the binary shipped inside the release archive (tools/) so a packaged
	# install needs no network. Fall back to the GitHub download below when the
	# archive did not carry it (older archive, skipped build, unbundled platform).
	if [[ -n "$bundled_root" && -f "${bundled_root}/tools/${binary}" ]]; then
		mkdir -p "$tool_dir"
		cp "${bundled_root}/tools/${binary}" "$target"
		chmod 755 "$target" 2>/dev/null || true
		return 0
	fi
	local metadata="${WORK_DIR}/${name}.json" version archive extract found
	# A missing search tool is non-fatal (grep/find fall back to git/POSIX at
	# runtime), so every failure below silently skips instead of warning.
	if ! download "https://api.github.com/repos/${repo}/releases/latest" "$metadata"; then
		return 0
	fi
	version="$(awk -F'"' '/"tag_name"[[:space:]]*:/ { print $4; exit }' "$metadata")"
	version="${version#v}"
	archive="${WORK_DIR}/${name}.archive"
	extract="${WORK_DIR}/${name}.extract"
	mkdir -p "$extract" "$tool_dir"
	if ! download_progress "https://github.com/${repo}/releases/download/${tag_prefix}${version}/${asset//VERSION/$version}" "$archive"; then
		return 0
	fi
	if [[ "$archive" == *.zip ]]; then unzip -q "$archive" -d "$extract" || return 0
	else tar -xzf "$archive" -C "$extract" || return 0; fi
	found="$(find "$extract" -type f -name "$binary" -print -quit)"
	[[ -n "$found" ]] || return 0
	cp "$found" "$target"
	chmod 755 "$target" 2>/dev/null || true
}

install_managed_tools() {
	# These are the same managed paths used by the Pi runtime wrapper. Existing
	# system commands remain valid; missing tools are copied from the release
	# archive's tools/ dir when present, otherwise fetched into Step storage.
	local bundled_root="$1"
	mkdir -p "$AGENT_DIR/bin"
	local fd_asset rg_asset
	if [[ "$TARGET_ID" == darwin-arm64 ]]; then fd_asset='fd-vVERSION-aarch64-apple-darwin.tar.gz'; rg_asset='ripgrep-VERSION-aarch64-apple-darwin.tar.gz'
	elif [[ "$TARGET_ID" == darwin-x64 ]]; then fd_asset='fd-vVERSION-x86_64-apple-darwin.tar.gz'; rg_asset='ripgrep-VERSION-x86_64-apple-darwin.tar.gz'
	elif [[ "$TARGET_ID" == linux-arm64 ]]; then fd_asset='fd-vVERSION-aarch64-unknown-linux-gnu.tar.gz'; rg_asset='ripgrep-VERSION-aarch64-unknown-linux-gnu.tar.gz'
	else fd_asset='fd-vVERSION-x86_64-unknown-linux-gnu.tar.gz'; rg_asset='ripgrep-VERSION-x86_64-unknown-linux-musl.tar.gz'; fi
	install_managed_tool fd fd "$fd_asset" sharkdp/fd v "$bundled_root"
	install_managed_tool rg rg "$rg_asset" BurntSushi/ripgrep '' "$bundled_root"
}

path_hint() {
	# Emit the manual instruction used both when PATH edits are opted out and as
	# the reminder for the current (already-started) shell.
	printf 'add %s to PATH for the current shell:\n  export PATH="%s:%s/bin:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" "$AGENT_DIR" >&2
}

profile_targets() {
	# The rc file(s) a future login/interactive shell of the user's login shell
	# will source. One path per line so callers can read it safely. Only reached
	# for shells whose PATH syntax is `export PATH=` (zsh/bash/POSIX); fish and
	# csh/tcsh are handled separately in configure_shell_path.
	case "$(basename "${SHELL:-}")" in
		zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash)
			# macOS Terminal opens login shells (.bash_profile); most Linux
			# interactive shells read .bashrc. Cover both so PATH sticks either way.
			printf '%s\n' "$HOME/.bashrc"
			[[ "$(uname -s)" == Darwin ]] && printf '%s\n' "$HOME/.bash_profile"
			;;
		*) printf '%s\n' "$HOME/.profile" ;;
	esac
}

strip_step_block() {
	# Remove a previously written, WELL-FORMED "# stepcode ... # stepcode end"
	# block (and any blank lines directly above it) so reinstalls stay idempotent.
	# A lone start marker with no matching end (a hand-edited rc, an interrupted
	# prior write, or an unrelated "# stepcode" comment) is emitted verbatim
	# rather than truncating everything below it to EOF. Returns non-zero (leaving
	# the file untouched) if the rewrite could not be produced, so the caller can
	# avoid appending a duplicate block on top of one it failed to remove.
	local file="$1" tmp
	tmp="$(mktemp "${file}.step.XXXXXX")" || return 1
	if awk '
		{
			if (inblock) {
				block = block $0 "\n"
				if ($0 == "# stepcode end") { inblock = 0; block = ""; blank = "" }
				next
			}
			if ($0 == "# stepcode") { inblock = 1; block = $0 "\n"; next }
			if ($0 ~ /^[[:space:]]*$/) { blank = blank $0 "\n"; next }
			if (blank != "") { printf "%s", blank; blank = "" }
			print
		}
		END {
			# Unterminated block: restore its lines (and preceding blanks) instead
			# of dropping them. Trailing blanks are preserved.
			if (inblock) { if (blank != "") printf "%s", blank; printf "%s", block }
			else if (blank != "") printf "%s", blank
		}
	' "$file" >"$tmp"; then
		cat "$tmp" >"$file"
		rm -f "$tmp"
		return 0
	fi
	rm -f "$tmp"
	return 1
}

configure_shell_path() {
	# Persist INSTALL_DIR onto PATH for future shells. Without this the installer
	# drops the binary into a directory nothing sources, so a fresh shell reports
	# "command not found: step". Opt out with STEP_NO_MODIFY_PATH=1 (package
	# managers, CI, or callers that manage PATH themselves).
	case ":${PATH}:" in *":${INSTALL_DIR}:"*) return 0 ;; esac
	if [[ -n "${STEP_NO_MODIFY_PATH:-}" ]]; then path_hint; return 0; fi

	# The install dir is interpolated into a shell-sourced file. Refuse to edit an
	# rc when a path contains characters that could break quoting or inject a
	# command, and fall back to a manual hint instead.
	case "${INSTALL_DIR}:${AGENT_DIR}/bin" in
		*'"'* | *'`'* | *'$'* | *$'\n'*)
			printf 'note: install dir contains characters unsafe to write into a shell profile; add it to PATH manually:\n  export PATH="%s:%s/bin:$PATH"\n' "$INSTALL_DIR" "$AGENT_DIR" >&2
			return 0
			;;
	esac

	local shell_name updated=0 rc
	shell_name="$(basename "${SHELL:-}")"

	case "$shell_name" in
		fish)
			# fish never sources ~/.profile and does not understand `export PATH=`;
			# it manages PATH with fish_add_path in config.fish.
			local fishcfg="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
			if mkdir -p "$(dirname "$fishcfg")" 2>/dev/null; then
				if [[ -f "$fishcfg" ]] && grep -qxF '# stepcode' "$fishcfg" 2>/dev/null && ! strip_step_block "$fishcfg"; then
					printf 'warning: could not update the existing stepcode block in %s; left it unchanged\n' "$fishcfg" >&2
				elif printf '\n# stepcode\nfish_add_path "%s" "%s/bin"\n# stepcode end\n' "$INSTALL_DIR" "$AGENT_DIR" >>"$fishcfg"; then
					printf 'added %s to PATH in %s\n' "$INSTALL_DIR" "$fishcfg"
					updated=1
				fi
			fi
			;;
		csh | tcsh)
			# csh/tcsh use a separate rc and `setenv` syntax we do not manage.
			printf 'note: %s is not auto-configured; add this to your ~/.%src:\n  setenv PATH "%s:%s/bin:$PATH"\n' "$shell_name" "$shell_name" "$INSTALL_DIR" "$AGENT_DIR" >&2
			return 0
			;;
		*)
			# zsh, bash, and POSIX sh/ksh/dash all accept `export PATH=`. The written
			# block guards against re-prepending, so sourcing it twice (e.g. a macOS
			# .bash_profile that sources .bashrc) still leaves a single PATH entry.
			while IFS= read -r rc; do
				[[ -n "$rc" ]] || continue
				mkdir -p "$(dirname "$rc")" 2>/dev/null || continue
				if [[ -f "$rc" ]] && grep -qxF '# stepcode' "$rc" 2>/dev/null && ! strip_step_block "$rc"; then
					printf 'warning: could not update the existing stepcode block in %s; left it unchanged\n' "$rc" >&2
					continue
				fi
				if printf '\n# stepcode\ncase ":$PATH:" in\n  *":%s:"*) ;;\n  *) export PATH="%s:%s/bin:$PATH" ;;\nesac\n# stepcode end\n' "$INSTALL_DIR" "$INSTALL_DIR" "$AGENT_DIR" >>"$rc"; then
					printf 'added %s to PATH in %s\n' "$INSTALL_DIR" "$rc"
					updated=1
				fi
			done < <(profile_targets)
			;;
	esac

	if [[ "$updated" -eq 1 ]]; then
		printf 'restart your shell (or run: exec %s) to pick it up.\n' "${shell_name:-your shell}"
	else
		path_hint
	fi
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
	# Detect an installer published without base-URL substitution. The sentinel is
	# assembled from two literals so the release renderer's token replacement cannot
	# rewrite this guard along with the real placeholder in the BASE_URL default.
	unconfigured_base_url='__STEP_RELEASE''_BASE_URL__'
	[[ "$BASE_URL" == "$unconfigured_base_url" ]] && die 'release base URL was not configured in this installer'
	detect_target
	WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stepcode-install.XXXXXX")"
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
	# Photon's wasm must sit next to the installed binary: photon.ts resolves it at
	# execDir/photon_rs_bg.wasm, and without it image resizing is disabled — read_file
	# can then only pass through images already within the inline budget, and larger
	# ones fail with "could not be resized". install.ps1 and self-update already ship
	# it; keep this Unix path in sync.
	if [[ -f "${archive_root}/photon_rs_bg.wasm" ]]; then
		cp "${archive_root}/photon_rs_bg.wasm" "${INSTALL_DIR}/photon_rs_bg.wasm"
	fi
	for dir in native theme assets export-html docs examples; do copy_runtime_dir "$archive_root" "$dir"; done
	install_managed_tools "$archive_root"
	"$destination" --version >/dev/null || die 'installed Step failed its smoke test'
	printf 'installed StepCode %s to %s\n' "$VERSION" "$destination"
	configure_shell_path
}

main "$@"
