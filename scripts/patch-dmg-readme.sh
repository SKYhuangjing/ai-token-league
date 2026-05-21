#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DMG_PATH=""
README_PATH="$PROJECT_ROOT/assets/mac-install-readme.txt"

usage() {
  cat <<EOF
Usage: $(basename "$0") --dmg PATH [--readme PATH]

Inject mac-install-readme.txt into the root of a macOS DMG installer.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg) DMG_PATH="$2"; shift 2 ;;
    --readme) README_PATH="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$DMG_PATH" ]]; then
  echo "Error: missing --dmg PATH" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: DMG patching requires macOS hdiutil" >&2
  exit 1
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "Error: hdiutil not found" >&2
  exit 1
fi

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Error: DMG not found: $DMG_PATH" >&2
  exit 1
fi

if [[ ! -f "$README_PATH" ]]; then
  echo "Error: readme not found: $README_PATH" >&2
  exit 1
fi

dir="$(dirname "$DMG_PATH")"
base="$(basename "$DMG_PATH" .dmg)"
tmp_sparse="$dir/${base}-rw.sparseimage"
tmp_compressed="$dir/${base}-final.dmg"
mount_point=""

cleanup() {
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -f "$tmp_sparse" "$tmp_compressed"
}
trap cleanup EXIT

rm -f "$tmp_sparse" "$tmp_compressed"

echo "Injecting $(basename "$README_PATH") into $(basename "$DMG_PATH")"
hdiutil convert "$DMG_PATH" -format UDSP -o "$tmp_sparse" >/dev/null

mount_output="$(hdiutil attach "$tmp_sparse" -nobrowse)"
mount_point="$(echo "$mount_output" | awk '/\/Volumes\// { match($0, /\/Volumes\/.*/); print substr($0, RSTART); exit }')"
if [[ -z "$mount_point" || ! -d "$mount_point" ]]; then
  echo "Error: failed to locate mounted DMG volume" >&2
  exit 1
fi

cp "$README_PATH" "$mount_point/mac-install-readme.txt"
test -f "$mount_point/mac-install-readme.txt"

vol_name="$(basename "$mount_point")"
osascript -e "
  tell application \"Finder\"
    set dmg_disk to disk \"$vol_name\"
    set position of item \"mac-install-readme.txt\" of dmg_disk to {240, 340}
  end tell
" >/dev/null 2>&1 || true

sync
hdiutil detach "$mount_point" >/dev/null
mount_point=""

hdiutil convert "$tmp_sparse" -format UDZO -o "$tmp_compressed" >/dev/null
mv "$tmp_compressed" "$DMG_PATH"
rm -f "$tmp_sparse"
echo "Injected mac-install-readme.txt into $DMG_PATH"
