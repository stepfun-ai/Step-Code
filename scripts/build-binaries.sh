#!/usr/bin/env bash
#
# Build Step binaries for all platforms locally.
# Mirrors .github/workflows/build-step-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--product <step>] [--skip-install] [--skip-deps] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip pnpm install
#   --skip-deps          Skip installing cross-platform dependencies
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --product <name>     Executables to build/archive (default: step)
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     step-darwin-arm64.tar.gz
#     step-darwin-x64.tar.gz
#     step-linux-x64.tar.gz
#     step-linux-arm64.tar.gz
#     step-windows-x64.zip
#     step-windows-arm64.zip
#
# Each archive contains only the Step executable.

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""
PRODUCT="step"
ARCHIVE_PREFIX="step"

# Step's product identity is independent from the upstream Pi package version.
# Release CI supplies these values from the tag; local/source builds use the
# stable Step fallback and a dev channel.
STEP_BUILD_VERSION="${STEPCODE_BUILD_VERSION:-0.1.0}"
STEP_BUILD_CHANNEL="${STEPCODE_BUILD_CHANNEL:-dev}"
STEP_BUILD_COMMIT="${STEPCODE_BUILD_COMMIT:-}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --product)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "--product requires a value"
                exit 1
            fi
            PRODUCT="$2"
            shift 2
            ;;
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

case "$PRODUCT" in
    step)
        ;;
    *)
        echo "Invalid product: $PRODUCT"
        echo "Valid products: step"
        exit 1
        ;;
esac

# A source archive does not contain `.git`, so a commit is optional there. For
# local builds, include a short commit when it is available. These canonical
# variables are the ones embedded by Bun's `--env` prefix below.
if [[ -z "$STEP_BUILD_COMMIT" ]]; then
    STEP_BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"
fi
STEP_BUILD_VERSION="${STEP_BUILD_VERSION#refs/tags/}"
STEP_BUILD_VERSION="${STEP_BUILD_VERSION#step-v}"
STEP_BUILD_VERSION="${STEP_BUILD_VERSION#pi-v}"
STEP_BUILD_VERSION="${STEP_BUILD_VERSION#v}"
# Only the two channels understood by the telemetry gate are embedded. A bad
# CI variable must fail closed to the local/dev behavior rather than silently
# enabling network delivery.
if [[ "$STEP_BUILD_CHANNEL" != "release" ]]; then
    STEP_BUILD_CHANNEL="dev"
fi
# Keep the envelope dimension bounded and consistent with the old short-SHA
# build metadata even when CI passes a full commit hash.
STEP_BUILD_COMMIT="${STEP_BUILD_COMMIT:0:12}"
export STEPCODE_BUILD_VERSION="$STEP_BUILD_VERSION"
export STEPCODE_BUILD_CHANNEL="$STEP_BUILD_CHANNEL"
if [[ -n "$STEP_BUILD_COMMIT" ]]; then
    export STEPCODE_BUILD_COMMIT="$STEP_BUILD_COMMIT"
fi

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    pnpm install --frozen-lockfile --ignore-scripts
else
    echo "==> Skipping pnpm install (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    CLIPBOARD_VERSION=$(node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
    # A workspace install only installs optional deps for the current platform.
    # Install the cross-platform packages in isolation so the package manager does
    # not re-resolve and mutate the workspace dependency graph. npm is used here
    # deliberately for this throwaway, lockfile-free fetch of platform-specific
    # optional binaries; it never touches the pnpm workspace.
    NATIVE_DEPS_DIR=$(mktemp -d)
    cleanup_native_deps() {
        rm -rf "$NATIVE_DEPS_DIR"
    }
    trap cleanup_native_deps EXIT
    printf '%s\n' '{"private":true}' > "$NATIVE_DEPS_DIR/package.json"
    # Use --force to bypass platform checks (os/cpu restrictions in package.json).
    npm install --prefix "$NATIVE_DEPS_DIR" --include=optional --no-save --package-lock=false --force --ignore-scripts \
        @mariozechner/clipboard@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-arm64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-x64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-x64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-arm64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-x64-msvc@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-arm64-msvc@"$CLIPBOARD_VERSION"
    mkdir -p node_modules/@mariozechner
    for package in \
        clipboard \
        clipboard-darwin-arm64 \
        clipboard-darwin-x64 \
        clipboard-linux-x64-gnu \
        clipboard-linux-arm64-gnu \
        clipboard-win32-x64-msvc \
        clipboard-win32-arm64-msvc; do
        rm -rf "node_modules/@mariozechner/$package"
        cp -R "$NATIVE_DEPS_DIR/node_modules/@mariozechner/$package" node_modules/@mariozechner/
    done
    cleanup_native_deps
    trap - EXIT
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        pnpm run build:offline
    else
        echo "==> Building all packages..."
        pnpm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

set_clipboard_target() {
    case "$1" in
        darwin-arm64)
            clipboard_native_package="clipboard-darwin-arm64"
            clipboard_native_file="clipboard.darwin-arm64.node"
            ;;
        darwin-x64)
            clipboard_native_package="clipboard-darwin-x64"
            clipboard_native_file="clipboard.darwin-x64.node"
            ;;
        linux-x64)
            clipboard_native_package="clipboard-linux-x64-gnu"
            clipboard_native_file="clipboard.linux-x64-gnu.node"
            ;;
        linux-arm64)
            clipboard_native_package="clipboard-linux-arm64-gnu"
            clipboard_native_file="clipboard.linux-arm64-gnu.node"
            ;;
        windows-x64)
            clipboard_native_package="clipboard-win32-x64-msvc"
            clipboard_native_file="clipboard.win32-x64-msvc.node"
            ;;
        windows-arm64)
            clipboard_native_package="clipboard-win32-arm64-msvc"
            clipboard_native_file="clipboard.win32-arm64-msvc.node"
            ;;
    esac
}

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before step starts (see #7684).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig '--env=STEPCODE_BUILD_*' --target="$bun_target" ../../apps/cli/dist/bun/stepcode.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/step.exe"
    else
        bun build --compile --no-compile-autoload-bunfig '--env=STEPCODE_BUILD_*' --target="$bun_target" ../../apps/cli/dist/bun/stepcode.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/step"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    if [[ "$PRODUCT" == "step" ]]; then
        # A Step-only archive is a product artifact, so its embedded package
        # metadata must not advertise the upstream Pi version. Keep the package
        # name and dependency graph intact, but stamp the tag-derived Step
        # version used by self-update and diagnostics.
        node -e '
            const fs = require("fs");
            const file = process.argv[1];
            const version = process.env.STEPCODE_BUILD_VERSION;
            const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
            manifest.version = version;
            fs.writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
        ' "$OUTPUT_DIR/$platform/package.json"
    fi
    cp README.md "$OUTPUT_DIR/$platform/"
    # StepCode keeps changelogs per package; older Pi source archives also
    # carried a repository-level CHANGELOG.md. Preserve it when present without
    # making the standalone Step build depend on a file this repository does not
    # have.
    if [[ -f CHANGELOG.md ]]; then
        cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    fi
    node ../../scripts/copy-photon-wasm.mjs "$OUTPUT_DIR/$platform"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    set_clipboard_target "$platform"
    mkdir -p "$OUTPUT_DIR/$platform/node_modules/@mariozechner"
    cp -r ../../node_modules/@mariozechner/clipboard "$OUTPUT_DIR/$platform/node_modules/@mariozechner/"
    cp "../../node_modules/@mariozechner/$clipboard_native_package/$clipboard_native_file" \
        "$OUTPUT_DIR/$platform/node_modules/@mariozechner/clipboard/"

    # Copy terminal input native helpers next to compiled binaries.
    if [[ "$platform" == darwin-* ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform"
        cp ../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform/"
    fi
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir"
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir/"
    fi

done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating $ARCHIVE_PREFIX-$platform.zip..."
        (cd "$platform" && zip -r ../$ARCHIVE_PREFIX-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating $ARCHIVE_PREFIX-$platform.tar.gz..."
        wrapper_dir="$ARCHIVE_PREFIX"
        mv "$platform" "$wrapper_dir" && tar -czf "$ARCHIVE_PREFIX-$platform.tar.gz" "$wrapper_dir" && mv "$wrapper_dir" "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../$ARCHIVE_PREFIX-$platform.zip)
    else
        tar -xzf "$ARCHIVE_PREFIX-$platform.tar.gz" && mv "$ARCHIVE_PREFIX" "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/step.exe"
    else
        echo "  $OUTPUT_DIR/$platform/step"
    fi
done
