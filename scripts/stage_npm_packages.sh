#!/usr/bin/env bash
# Stage platform-specific npm tarballs from a locally-built binary.
#
# Usage:
#   scripts/stage_npm_packages.sh [<target-triple>]
#
# If no target is passed, defaults to the host target.

set -euo pipefail

cd "$(dirname "$0")/.."

# Locate cargo via rustup if not on PATH
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -d "$HOME/.rustup/toolchains" ]]; then
    TOOLCHAIN_DIR=$(ls -d "$HOME/.rustup/toolchains/stable-"* 2>/dev/null | head -1 || true)
    if [[ -n "${TOOLCHAIN_DIR:-}" ]]; then
      export PATH="${TOOLCHAIN_DIR}/bin:${PATH}"
    fi
  fi
fi

# Determine target triple
TARGET="${1:-$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}')}"
if [[ -z "${TARGET}" ]]; then
  echo "ERROR: Could not determine target triple. Pass one explicitly." >&2
  exit 1
fi

# Map target -> {platform, arch}
case "${TARGET}" in
  x86_64-unknown-linux-gnu) PLATFORM=linux; ARCH=x64; LIBC=glibc ;;
  x86_64-unknown-linux-musl) PLATFORM=linux; ARCH=x64; LIBC=musl ;;
  aarch64-unknown-linux-gnu) PLATFORM=linux; ARCH=arm64; LIBC=glibc ;;
  aarch64-unknown-linux-musl) PLATFORM=linux; ARCH=arm64; LIBC=musl ;;
  x86_64-apple-darwin) PLATFORM=darwin; ARCH=x64 ;;
  aarch64-apple-darwin) PLATFORM=darwin; ARCH=arm64 ;;
  *) echo "ERROR: Unsupported target: ${TARGET}" >&2; exit 1 ;;
esac

if [[ "${PLATFORM}" == "linux" && "${ARCH}" == "x64" && "${LIBC:-}" == "musl" ]]; then
  PKG_NAME="starling-${PLATFORM}-${ARCH}-musl"
else
  PKG_NAME="starling-${PLATFORM}-${ARCH}"
fi
VERSION=$(grep -m1 '^version' rust/Cargo.toml | sed -E 's/version *= *"([^"]+)".*/\1/')
BINARY="rust/target/${TARGET}/release/starling"

if [[ ! -f "${BINARY}" ]]; then
  echo ">> Building ${TARGET}..."
  (cd rust && cargo build --release --target "${TARGET}")
fi

STAGE="dist/${PKG_NAME}"
echo ">> Staging into ${STAGE}/"
rm -rf "${STAGE}"
mkdir -p "${STAGE}/vendor/${TARGET}/bin"
cp "${BINARY}" "${STAGE}/vendor/${TARGET}/bin/starling"
chmod +x "${STAGE}/vendor/${TARGET}/bin/starling"

# Generate package.json via node to keep quoting clean.
PKG_NAME="${PKG_NAME}" VERSION="${VERSION}" PLATFORM="${PLATFORM}" ARCH="${ARCH}" LIBC="${LIBC:-}" STAGE="${STAGE}" node -e '
  const fs = require("fs");
  const pkg = {
    name: process.env.PKG_NAME,
    version: process.env.VERSION,
    description: "Pre-built starling binary for " + process.env.PLATFORM + "-" + process.env.ARCH,
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/huang-sh/Starling",
    },
    os: [process.env.PLATFORM],
    cpu: [process.env.ARCH],
    files: ["vendor/"],
  };
  if (process.env.LIBC) {
    pkg.libc = [process.env.LIBC];
  }
  fs.writeFileSync(process.env.STAGE + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
'

echo ">> npm pack..."
(cd "${STAGE}" && npm pack)

echo ">> Staged: ${STAGE}/${PKG_NAME}-${VERSION}.tgz"
