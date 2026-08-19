#!/usr/bin/env bash
# Pack the starling-ai tarball, stamping the version from rust/Cargo.toml.
#
# The in-repo npm/package.json carries NO version on purpose: Cargo.toml is
# the single source of truth. This script stages a copy with the version
# stamped in (plus the platform optionalDependencies), then npm packs it.
# npm pack honors the "files" whitelist, so staging the whole dir is safe.

set -euo pipefail
ROOT_DIR="$(pwd)"
cd "$(dirname "$0")/.."

VERSION=$(grep -m1 '^version' rust/Cargo.toml | sed -E 's/version *= *"([^"]+)".*/\1/')
STAGE=dist/starling-ai

rm -rf "${STAGE}"
mkdir -p "${STAGE}"
cp -r npm/. "${STAGE}/"

VERSION="${VERSION}" STAGE="${STAGE}" node -e '
  const fs = require("fs");
  const path = process.env.STAGE + "/package.json";
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.version = process.env.VERSION;
  for (const key of Object.keys(pkg.optionalDependencies ?? {})) {
    if (key.startsWith("starling-")) pkg.optionalDependencies[key] = process.env.VERSION;
  }
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
'

(cd "${STAGE}" && npm pack --silent --pack-destination "${ROOT_DIR}/dist")
echo ">> Staged: dist/starling-ai-${VERSION}.tgz"
