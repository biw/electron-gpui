#!/usr/bin/env bash
# Electron's installer (extract-zip) can drop Electron.app/Contents/Frameworks
# under newer Node releases, leaving an app that fails to launch. Re-extract
# the downloaded zip with ditto when that happens.
set -euo pipefail

# Resolve the electron package the current project uses (pnpm nests it per package).
ELECTRON_DIR="$(node -p "require('path').dirname(require.resolve('electron/package.json'))")"
FRAMEWORK="${ELECTRON_DIR}/dist/Electron.app/Contents/Frameworks/Electron Framework.framework"

[[ -d "${FRAMEWORK}" ]] && exit 0

VERSION="$(node -p "require('${ELECTRON_DIR}/package.json').version")"
ARCH="$(uname -m)"
ZIP_NAME="electron-v${VERSION}-darwin-${ARCH}.zip"

find_zip() {
  # The cache directory may not exist yet (fresh machines, CI).
  find "${electron_config_cache:-${HOME}/Library/Caches/electron}" -name "${ZIP_NAME}" 2>/dev/null | head -n 1 || true
}

ZIP="$(find_zip)"
if [[ -z "${ZIP}" ]]; then
  # Let Electron's installer download (and cache) the zip first.
  rm -rf "${ELECTRON_DIR}/dist"
  node "${ELECTRON_DIR}/install.js"
  [[ -d "${FRAMEWORK}" ]] && exit 0
  ZIP="$(find_zip)"
fi

if [[ -z "${ZIP}" ]]; then
  echo "[electron] Could not find ${ZIP_NAME} to repair the Electron install" >&2
  exit 1
fi

echo "[electron] Re-extracting ${ZIP_NAME} with ditto" >&2
rm -rf "${ELECTRON_DIR}/dist"
mkdir -p "${ELECTRON_DIR}/dist"
ditto -x -k "${ZIP}" "${ELECTRON_DIR}/dist"
printf 'Electron.app/Contents/MacOS/Electron' > "${ELECTRON_DIR}/path.txt"
