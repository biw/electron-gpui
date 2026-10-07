#!/usr/bin/env bash
# Remove Cargo build output that hasn't been used recently, so target/ doesn't
# grow without bound. Runs at most once a day unless --force is passed.
#
#   scripts/sweep-cargo.sh [--force]
#
# Requires cargo-sweep (`cargo install cargo-sweep`); without it this prints a
# hint and exits successfully so builds never fail because of cleanup.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-${ROOT_DIR}/target}"
STAMP="${TARGET_DIR}/.last-sweep"
KEEP_DAYS="${ELECTRON_GPUI_SWEEP_DAYS:-7}"

[[ -d "${TARGET_DIR}" ]] || exit 0

if ! cargo sweep --version >/dev/null 2>&1; then
  echo "[sweep] cargo-sweep not installed; skipping cleanup (cargo install cargo-sweep)" >&2
  exit 0
fi

if [[ "${1:-}" != "--force" && -f "${STAMP}" ]] && [[ -z "$(find "${STAMP}" -mtime +0)" ]]; then
  exit 0
fi

before="$(du -sk "${TARGET_DIR}" | cut -f1)"
(
  cd "${ROOT_DIR}"
  cargo sweep --time "${KEEP_DAYS}" >/dev/null
  cargo sweep --installed >/dev/null
)
touch "${STAMP}"
after="$(du -sk "${TARGET_DIR}" | cut -f1)"
echo "[sweep] target/: $((before / 1024)) MB -> $((after / 1024)) MB (kept output used in the last ${KEEP_DAYS} days)" >&2
