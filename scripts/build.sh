#!/usr/bin/env bash
# Build the Starling Rust binary and stage it for npm distribution.
#
# Usage:
#   scripts/build.sh                # release build for host target
#   scripts/build.sh --debug        # debug build for host target
#   scripts/build.sh --target=<T>   # cross-compile for a specific target
#
# Output: npm/vendor/<target>/bin/starling

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUST_DIR="${ROOT_DIR}/rust"
VENDOR_DIR="${ROOT_DIR}/npm/vendor"
TSC="${ROOT_DIR}/node_modules/.bin/tsc"

DEBUG=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --debug)
      DEBUG=1
      ;;
    --target=*)
      TARGET="${arg#--target=}"
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# Discover cargo (handle rustup toolchains not in PATH)
if ! command -v cargo >/dev/null 2>&1; then
  if [ -x "${HOME}/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo" ]; then
    export PATH="${HOME}/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:${PATH}"
  else
    echo "cargo not found in PATH and no rustup toolchain detected" >&2
    exit 1
  fi
fi

cd "${RUST_DIR}"

if [ -f "${ROOT_DIR}/tsconfig.json" ]; then
  if [ -x "${TSC}" ]; then
    echo "Building Starling TypeScript CLI renderer…"
    "${TSC}" -p "${ROOT_DIR}/tsconfig.json"
  else
    echo "warning: TypeScript compiler not found; skipping npm/lib rebuild" >&2
  fi
fi

BUILD_PROFILE="release"
CARGO_ARGS=(--release)
if [ "$DEBUG" -eq 1 ]; then
  BUILD_PROFILE="debug"
  CARGO_ARGS=()
fi

if [ -n "$TARGET" ]; then
  CARGO_ARGS+=(--target "$TARGET")
  TARGET_DIR="${RUST_DIR}/target/${TARGET}/${BUILD_PROFILE}"
else
  TARGET_DIR="${RUST_DIR}/target/${BUILD_PROFILE}"
fi

echo "Building starling (${BUILD_PROFILE})…"
cargo build "${CARGO_ARGS[@]}"

if [ ! -f "${TARGET_DIR}/starling" ]; then
  echo "Build succeeded but binary not found at ${TARGET_DIR}/starling" >&2
  exit 1
fi

# Determine the vendor target triple. Use the explicit --target if provided,
# otherwise fall back to the host's default (rustc -vV).
if [ -z "$TARGET" ]; then
  TARGET="$(rustc -vV | sed -n 's/^host: //p')"
fi

STAGE_DIR="${VENDOR_DIR}/${TARGET}/bin"
mkdir -p "${STAGE_DIR}"
cp -f "${TARGET_DIR}/starling" "${STAGE_DIR}/starling"
chmod +x "${STAGE_DIR}/starling"

echo "Staged binary: ${STAGE_DIR}/starling"
"${STAGE_DIR}/starling" --version
