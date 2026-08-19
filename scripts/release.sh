#!/usr/bin/env bash
# Bump the release version, commit, and tag.
#
# Usage:
#   scripts/release.sh <semver>    # e.g. scripts/release.sh 0.6.0
#
# Cargo.toml is the ONLY file that stores the version. Tarballs get it
# stamped at pack time (scripts/pack.sh, scripts/stage_npm_packages.sh).

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?Usage: scripts/release.sh <semver>}"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "ERROR: not a semver: ${VERSION}" >&2
  exit 1
}

sed -i.bak -E "s/^version = \"[^\"]+\"/version = \"${VERSION}\"/" rust/Cargo.toml && rm rust/Cargo.toml.bak
# Sync the workspace version into Cargo.lock (CI builds with --locked;
# a stale lock entry there fails the release).
(cd rust && cargo update --workspace --quiet)

git add rust/Cargo.toml rust/Cargo.lock
git commit -m "release: v${VERSION}"
git tag "v${VERSION}"
echo ">> v${VERSION} committed and tagged. Push with: git push && git push --tags"
