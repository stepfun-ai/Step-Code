#!/usr/bin/env bash
# Create the deterministic source archive consumed by the release environment.
#
# Usage:
#   npm run hydrate:model-data
#   ./scripts/create-source-archive.sh --version <version> --ref <git-ref> --out <archive.tar.gz>

set -euo pipefail

version=""
source_ref="HEAD"
output=""
invocation_dir="$PWD"

usage() {
    echo "Usage: $0 --version <version> [--ref <git-ref>] --out <archive.tar.gz>"
}

require_value() {
    if [[ $# -lt 2 || -z "$2" ]]; then
        echo "$1 requires a value" >&2
        usage >&2
        exit 1
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            require_value "$@"
            version="$2"
            shift 2
            ;;
        --ref)
            require_value "$@"
            source_ref="$2"
            shift 2
            ;;
        --out)
            require_value "$@"
            output="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$version" || -z "$output" ]]; then
    usage >&2
    exit 1
fi

if [[ ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
    echo "Invalid version: $version" >&2
    exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

commit="$(git rev-parse --verify --end-of-options "${source_ref}^{commit}")"

# The archive name follows the release tag supplied by the Step release job.
# Step and the upstream Pi package intentionally have independent versions: the
# `step` facade embeds the tag, while ordinary `pi` keeps its upstream package
# version. Do not reject a valid Step tag merely because package.json still says
# the Pi runtime version.
package_version="$(git show "${commit}:packages/coding-agent/package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
if [[ -z "$package_version" ]]; then
    echo "Could not read Pi package version at ${source_ref}" >&2
    exit 1
fi

if [[ "$output" != /* ]]; then
    output="$invocation_dir/$output"
fi
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

model_data_dir="packages/providers/src/providers/data"
if [[ ! -f "${model_data_dir}/.manifest.json" ]]; then
    echo "Generated model data is missing. Run npm run hydrate:model-data first." >&2
    exit 1
fi

shopt -s nullglob
model_data_files=("${model_data_dir}/.manifest.json" "${model_data_dir}"/*.json)
shopt -u nullglob
# Step-only source trees legitimately contain only the empty manifest. Other
# catalogs must include one JSON shard for every generated provider import.
if [[ ${#model_data_files[@]} -eq 1 ]] && git show "${commit}:packages/providers/src/models.generated.ts" | grep -Eq '^import \{ [A-Z][A-Z0-9_]*_MODELS \} from "\./providers/[^" ]+\.models\.ts";$'; then
	echo "Generated model data is missing from ${model_data_dir}" >&2
	exit 1
fi

temporary_archive="$(mktemp "${output}.tmp.XXXXXX")"
temporary_index="$(mktemp "${output}.index.XXXXXX")"
manifest="$(mktemp "${output}.manifest.XXXXXX")"
validation_root="$(mktemp -d "${output}.validation.XXXXXX")"
rm -f "$temporary_index"
trap 'rm -f "$temporary_archive" "$temporary_index" "$manifest"; rm -rf "$validation_root"' EXIT

# Add the ignored release model-data snapshot to a temporary index based on the
# release commit. Archiving the resulting tree keeps the source artifact
# deterministic for the same commit and generated model data.
GIT_INDEX_FILE="$temporary_index" git read-tree "$commit"
GIT_INDEX_FILE="$temporary_index" git add -f -- "${model_data_files[@]}"
archive_tree="$(GIT_INDEX_FILE="$temporary_index" git write-tree)"
archive_mtime="$(git show -s --format=%ct "$commit")"

archive_root="step-${version}"
archive_options=(--format=tar --prefix="${archive_root}/")
if git archive -h 2>&1 | grep -q -- '--mtime'; then
	archive_options+=(--mtime="@${archive_mtime}")
fi
git archive "${archive_options[@]}" "$archive_tree" ':(exclude)**/*.map' | gzip -n -9 > "$temporary_archive"
tar -tzf "$temporary_archive" > "$manifest"

required_paths=(
    "package.json"
	"pnpm-lock.yaml"
	"scripts/build-binaries.sh"
	"packages/providers/src/models.generated.ts"
	"packages/providers/src/providers/data/.manifest.json"
    "packages/coding-agent/package.json"
    "apps/cli/src/bun/stepcode.ts"
    "apps/cli/src/main.ts"
    "packages/coding-agent/src/step/stdio-host.ts"
    "packages/coding-agent/src/utils/image-resize-worker.ts"
    "packages/coding-agent/src/core/export-html/template.css"
)

for path in "${required_paths[@]}"; do
    if ! grep -Fxq "${archive_root}/${path}" "$manifest"; then
        echo "Source archive is missing required path: $path" >&2
        exit 1
    fi
done

if ! awk -v prefix="${archive_root}/" 'index($0, prefix) != 1 { exit 1 }' "$manifest"; then
    echo "Source archive contains a path outside ${archive_root}/" >&2
    exit 1
fi

if grep -Eq '(^|/)node_modules/|(^|/)packages/coding-agent/binaries/' "$manifest"; then
    echo "Source archive contains generated dependencies or binaries" >&2
    exit 1
fi

tar -xzf "$temporary_archive" -C "$validation_root"
node "${validation_root}/${archive_root}/packages/providers/scripts/check-model-data.ts"

mv "$temporary_archive" "$output"
trap 'rm -f "$temporary_index" "$manifest"; rm -rf "$validation_root"' EXIT
printf '%s\n' "$output"
