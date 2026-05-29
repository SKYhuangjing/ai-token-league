#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DMG_PATH=""
REPAIR_PATH="$PROJECT_ROOT/assets/mac-dmg-repair.command"
REPAIR_ICON_PATH="$PROJECT_ROOT/assets/mac-dmg-repair-icon.png"

usage() {
  cat <<EOF
Usage: $(basename "$0") --dmg PATH [--repair PATH] [--repair-icon PATH]

Prepare a macOS DMG installer with a repair helper and Finder layout.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg) DMG_PATH="$2"; shift 2 ;;
    --repair) REPAIR_PATH="$2"; shift 2 ;;
    --repair-icon) REPAIR_ICON_PATH="$2"; shift 2 ;;
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

if [[ ! -f "$REPAIR_PATH" ]]; then
  echo "Error: repair helper not found: $REPAIR_PATH" >&2
  exit 1
fi

if [[ ! -f "$REPAIR_ICON_PATH" ]]; then
  echo "Error: repair helper icon not found: $REPAIR_ICON_PATH" >&2
  exit 1
fi

apply_custom_icon() {
  local icon_path="$1"
  local target_path="$2"
  local icon_tmp_dir
  local icon_source
  local icon_rsrc
  icon_tmp_dir="$(mktemp -d /tmp/atl-dmg-icon.XXXXXX)"
  icon_source="$icon_tmp_dir/icon.png"
  icon_rsrc="$icon_tmp_dir/icon.rsrc"
  if command -v sips >/dev/null 2>&1 && command -v DeRez >/dev/null 2>&1 && command -v Rez >/dev/null 2>&1 && command -v SetFile >/dev/null 2>&1; then
    cp "$icon_path" "$icon_source"
    sips -i "$icon_source" >/dev/null
    DeRez -only icns "$icon_source" > "$icon_rsrc"
    Rez -append "$icon_rsrc" -o "$target_path"
    SetFile -a C "$target_path"
  else
    echo "Warning: sips, DeRez, Rez, or SetFile not found; skipping custom repair helper icon" >&2
  fi
  rm -rf "$icon_tmp_dir"
}

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

echo "Preparing installer layout for $(basename "$DMG_PATH")"
hdiutil convert "$DMG_PATH" -format UDSP -o "$tmp_sparse" >/dev/null

mount_output="$(hdiutil attach "$tmp_sparse" -nobrowse)"
mount_point="$(echo "$mount_output" | awk '/\/Volumes\// { match($0, /\/Volumes\/.*/); print substr($0, RSTART); exit }')"
if [[ -z "$mount_point" || ! -d "$mount_point" ]]; then
  echo "Error: failed to locate mounted DMG volume" >&2
  exit 1
fi

cp "$REPAIR_PATH" "$mount_point/已损坏修复.command"
chmod 755 "$mount_point/已损坏修复.command"
apply_custom_icon "$REPAIR_ICON_PATH" "$mount_point/已损坏修复.command"
test -x "$mount_point/已损坏修复.command"

vol_name="$(basename "$mount_point")"
osascript -e "
  tell application \"Finder\"
    set dmg_disk to disk \"$vol_name\"
    open dmg_disk
    set current view of container window of dmg_disk to icon view
    set toolbar visible of container window of dmg_disk to false
    set statusbar visible of container window of dmg_disk to false
    set bounds of container window of dmg_disk to {120, 100, 820, 560}
    set theViewOptions to icon view options of container window of dmg_disk
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set background color of theViewOptions to {65535, 65535, 65535}
    set position of item \"AI Token League.app\" of dmg_disk to {170, 155}
    set position of item \"Applications\" of dmg_disk to {530, 155}
    set position of item \"已损坏修复.command\" of dmg_disk to {350, 345}
    set extension hidden of item \"已损坏修复.command\" of dmg_disk to true
    update dmg_disk
    close container window of dmg_disk
  end tell
" >/dev/null 2>&1 || true

sync
hdiutil detach "$mount_point" >/dev/null
mount_point=""

hdiutil convert "$tmp_sparse" -format UDZO -o "$tmp_compressed" >/dev/null
mv "$tmp_compressed" "$DMG_PATH"
rm -f "$tmp_sparse"
echo "Prepared installer layout in $DMG_PATH"
