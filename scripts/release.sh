#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- defaults (interactive mode will override) ---
VERSION=""
PLATFORM=""
ENV_FILE=""
UPLOAD=""
AUTO_YES=false

TAURI_BUNDLE_BASE="src-tauri/target"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Interactive release builder for AI Token League (Tauri).
Without flags, runs in interactive mode with prompts.

Options:
  --version VER     Version to release (default: current from package.json)
  --platform PLAT   Platform: current | mac-arm64 | mac-intel | mac-all | win | all (default: all)
  --env FILE        Env file for presets and upload credentials
  --upload          Upload artifacts to OSS after build; builds all platforms
  --yes             Skip confirmation prompt
  -h, --help        Show this help message

Examples:
  $(basename "$0")                                      # fully interactive
  $(basename "$0") --platform current --yes             # quick current-machine build
  $(basename "$0") --platform mac-arm64 --yes           # quick mac-arm64 build
  $(basename "$0") --version 0.6.0 --upload --yes      # bump + build + upload
  $(basename "$0") --env env.prod --upload              # full release with env
EOF
  exit 0
}

# --- parse CLI flags ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     VERSION="$2"; shift 2 ;;
    --platform)    PLATFORM="$2"; shift 2 ;;
    --env)         ENV_FILE="$2"; shift 2 ;;
    --upload)      UPLOAD="yes"; shift ;;
    --yes)         AUTO_YES=true; shift ;;
    -h|--help)     usage ;;
    *)             echo "Unknown option: $1"; usage ;;
  esac
done

# --- helpers ---
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  if [[ "$AUTO_YES" == true && -n "$default" ]]; then
    eval "$var_name='$default'"
    return
  fi
  read -rp "$prompt_text" input
  eval "$var_name='${input:-$default}'"
}

prompt_yn() {
  local var_name="$1" prompt_text="$2" default="$3"
  if [[ "$AUTO_YES" == true ]]; then
    eval "$var_name='$default'"
    return
  fi
  local hint="y/N"
  [[ "$default" == "yes" ]] && hint="Y/n"
  read -rp "$prompt_text [$hint] " input
  case "${input:-$default}" in
    y|Y|yes) eval "$var_name='yes'" ;;
    *)       eval "$var_name='no'" ;;
  esac
}

detect_current_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64)  echo "mac-arm64" ;;
    Darwin:x86_64) echo "mac-intel" ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) echo "win" ;;
    *)
      echo "Error: unsupported current platform: $os $arch" >&2
      echo "Use --platform mac-arm64, mac-intel, mac-all, win, or all." >&2
      exit 1
      ;;
  esac
}

# --- check prerequisites ---
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "Error: Node.js >= 22 required, found $(node -v)"
  exit 1
fi

if ! command -v cargo &>/dev/null; then
  echo "Error: cargo (Rust) not found. Install from https://rustup.rs"
  exit 1
fi

# --- read current version ---
CURRENT_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

echo ""
echo "=== AI Token League Release Builder (Tauri) ==="
echo ""

# --- step 1: version ---
if [[ -z "$VERSION" ]]; then
  prompt VERSION "Version to release [${CURRENT_VERSION}]: " "$CURRENT_VERSION"
fi

if [[ "$VERSION" != "$CURRENT_VERSION" ]]; then
  echo "  Bumping version: $CURRENT_VERSION -> $VERSION"
  npm run bump -- "$VERSION"
fi
echo "  Version: $VERSION"

# --- step 2: platform ---
if [[ -z "$PLATFORM" ]]; then
  echo ""
  echo "  Platforms:"
  echo "    1) macOS arm64 (Apple Silicon)"
  echo "    2) macOS x64   (Intel)"
  echo "    3) macOS All   (arm64 + Intel)"
  echo "    4) Windows x64"
  echo "    5) All platforms"
  echo "    6) Current machine"
  echo ""
  prompt PLATFORM "Select platform [5]: " "5"
fi

case "$PLATFORM" in
  6|current)    PLATFORM="$(detect_current_platform)" ;;
esac

case "$PLATFORM" in
  1|mac-arm64)  PLATFORM="mac-arm64";  PLATFORM_LABEL="macOS arm64" ;;
  2|mac-intel)  PLATFORM="mac-intel";  PLATFORM_LABEL="macOS Intel" ;;
  3|mac-all)    PLATFORM="mac-all";    PLATFORM_LABEL="macOS All" ;;
  4|win)        PLATFORM="win";        PLATFORM_LABEL="Windows x64" ;;
  5|all)        PLATFORM="all";        PLATFORM_LABEL="All platforms" ;;
  *)            echo "Invalid platform: $PLATFORM"; exit 1 ;;
esac
echo "  Platform: $PLATFORM_LABEL"

# --- step 3: env file ---
if [[ -z "$ENV_FILE" ]]; then
  echo ""
  echo "  Env file (for presets and upload credentials):"
  echo "    1) Skip (no presets, no upload)"
  echo "    2) env.local"
  echo "    3) Custom path"
  echo ""
  prompt ENV_CHOICE "Select [1]: " "1"
  case "$ENV_CHOICE" in
    2) ENV_FILE="env.local" ;;
    3) read -rp "  Env file path: " ENV_FILE ;;
    *) ENV_FILE="" ;;
  esac
fi

if [[ -n "$ENV_FILE" ]]; then
  [[ "$ENV_FILE" != /* ]] && ENV_FILE="$PROJECT_ROOT/$ENV_FILE"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "  Warning: env file not found: $ENV_FILE"
    ENV_FILE=""
  else
    echo "  Env file: $ENV_FILE"
  fi
fi

# --- step 4: upload ---
if [[ -z "$UPLOAD" ]]; then
  prompt_yn UPLOAD "  Upload to OSS after build? [y/N] " "no"
fi

if [[ "$UPLOAD" == "yes" && -z "$ENV_FILE" ]]; then
  echo "  Error: upload requires an env file with OSS credentials"
  exit 1
fi
if [[ "$UPLOAD" == "yes" && "$PLATFORM" != "all" ]]; then
  echo "  Upload publishes the full release set; switching platform to all."
  PLATFORM="all"
  PLATFORM_LABEL="All platforms"
fi
echo "  Upload: $UPLOAD"

# --- step 5: confirm ---
echo ""
echo "  --- Summary ---"
echo "  Version:  $VERSION"
echo "  Platform: $PLATFORM_LABEL"
echo "  Env file: ${ENV_FILE:-none}"
echo "  Upload:   $UPLOAD"
echo ""

if [[ "$AUTO_YES" != true ]]; then
  read -rp "  Proceed? [Y/n] " confirm
  case "$confirm" in
    n|N|no) echo "Aborted."; exit 0 ;;
  esac
fi

# --- execute pipeline ---
echo ""

# preset
if [[ -n "$ENV_FILE" ]]; then
  echo ">>> Writing preset from $ENV_FILE..."
  node scripts/build-preset.js --env "$ENV_FILE"
else
  echo ">>> No env file, writing empty preset..."
  node scripts/build-preset.js
fi

# clean previous build artifacts
echo ">>> Cleaning previous build artifacts..."
rm -rf dist dist-installer

# Resolve the bundle directory for a given rust target.
# cargo tauri build --target X always outputs to target/X/release/bundle.
resolve_bundle_dir() {
  local rust_target="$1"
  echo "$TAURI_BUNDLE_BASE/$rust_target/release/bundle"
}

# Tauri build
# Cross-compilation notes:
#   - macOS arm64 (native): full build with app + dmg + updater
#   - macOS Intel (cross): app + updater only (--bundles app skips DMG)
#   - Windows: must be built natively on Windows (ring/cross-deps don't cross-compile)
run_tauri_build() {
  local native_arch
  native_arch="$(uname -m)"

  build_mac_target() {
    local rust_target="$1"
    local arch_label="$2"
    local exit_code=0
    if [[ "$native_arch" == "arm64" && "$rust_target" == "aarch64-apple-darwin" ]] || \
       [[ "$native_arch" == "x86_64" && "$rust_target" == "x86_64-apple-darwin" ]]; then
      echo ">>> Building $arch_label (native)..."
      npx tauri build --target "$rust_target" || exit_code=$?
    else
      echo ">>> Building $arch_label (cross, app + updater only)..."
      npx tauri build --target "$rust_target" --bundles app || exit_code=$?
    fi
    # Signing fails without TAURI_SIGNING_PRIVATE_KEY but artifacts are still generated.
    # Only treat as fatal if the .app bundle itself wasn't created.
    if [[ $exit_code -ne 0 ]]; then
      local bundle_dir
      bundle_dir="$(resolve_bundle_dir "$rust_target")"
      if [[ ! -d "$bundle_dir/macos/AI Token League.app" ]]; then
        echo "Error: Tauri build failed for $arch_label (exit code $exit_code)"
        exit 1
      fi
      echo "  Warning: build exited with code $exit_code (likely missing TAURI_SIGNING_PRIVATE_KEY). Artifacts are available."
    fi
  }

  case "$1" in
    mac-arm64)  build_mac_target aarch64-apple-darwin "macOS arm64" ;;
    mac-intel)  build_mac_target x86_64-apple-darwin "macOS Intel" ;;
    win)
      if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
        echo "Error: Windows build requires native Windows (MSYS2/MinGW). Cross-compilation from macOS is not supported."
        exit 1
      fi
      echo ">>> Building Windows x64..."
      npx tauri build --target x86_64-pc-windows-msvc
      ;;
    mac-all)
      build_mac_target aarch64-apple-darwin "macOS arm64"
      build_mac_target x86_64-apple-darwin "macOS Intel"
      ;;
    all)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        build_mac_target aarch64-apple-darwin "macOS arm64"
        build_mac_target x86_64-apple-darwin "macOS Intel"
      elif [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
        echo ">>> Building Windows x64..."
        npx tauri build --target x86_64-pc-windows-msvc
      else
        echo ">>> Building for current platform..."
        npx tauri build
      fi
      ;;
    *)
      echo ">>> Building for current platform..."
      npx tauri build
      ;;
  esac
}

echo ">>> Building Tauri app for $PLATFORM_LABEL..."
run_tauri_build "$PLATFORM"

# Collect artifacts into dist/ for publish-release.js
# Disable strict mode during collection — hdiutil may fail on some steps
set +e
echo ">>> Collecting artifacts..."
mkdir -p dist

# Inject mac-install-readme.txt into an existing DMG.
# Tauri creates the DMG (compressed). We convert to sparse (rw), add file, re-compress.
inject_readme_into_dmg() {
  local dmg_path="$1"
  local readme="$PROJECT_ROOT/assets/mac-install-readme.txt"
  if [[ ! -f "$readme" ]]; then return 0; fi
  if [[ ! -f "$dmg_path" ]]; then return 0; fi

  local dir base tmp_sparse tmp_compressed
  dir="$(dirname "$dmg_path")"
  base="$(basename "$dmg_path" .dmg)"
  tmp_sparse="$dir/${base}-rw.sparseimage"
  tmp_compressed="$dir/${base}-final.dmg"

  # Compressed DMG → sparse (read-write)
  hdiutil convert "$dmg_path" -format UDSP -o "$tmp_sparse" 2>/dev/null || return 0

  # Mount, copy readme, unmount
  local mount_output mount_point
  mount_output=$(hdiutil attach "$tmp_sparse" -nobrowse 2>/dev/null) || { rm -f "$tmp_sparse"; return 0; }
  mount_point=$(echo "$mount_output" | grep "/Volumes/" | sed 's|^.*\(/Volumes/.*\)$|\1|')

  if [[ -n "$mount_point" ]]; then
    cp "$readme" "$mount_point/mac-install-readme.txt" || true
    sync
    hdiutil detach "$mount_point" 2>/dev/null || true
  fi

  # Sparse → compressed DMG (temp file, then replace)
  hdiutil convert "$tmp_sparse" -format UDZO -o "$tmp_compressed" 2>/dev/null || true
  rm -f "$tmp_sparse"
  if [[ -f "$tmp_compressed" ]]; then
    mv "$tmp_compressed" "$dmg_path"
  fi
  return 0
}

collect_mac_artifacts() {
  local arch="$1"
  local rust_target="$2"
  local bundle_dir
  bundle_dir="$(resolve_bundle_dir "$rust_target")"
  local target_dir="$bundle_dir/macos"
  local dmg_dir="$bundle_dir/dmg"

  local suffix=""
  [[ "$arch" == "arm64" ]] && suffix="-darwin-arm64"
  [[ "$arch" == "x64" ]] && suffix="-darwin-x64"

  # .app bundle (arch-suffixed to avoid overwrite when building both)
  if [[ -d "$target_dir/AI Token League.app" ]]; then
    cp -R "$target_dir/AI Token League.app" "dist/AI Token League${suffix}.app"
  fi

  # DMG installer (native builds only) — inject readme
  local dmg
  dmg=$(find "$dmg_dir" -name "*.dmg" 2>/dev/null | head -1)
  if [[ -n "$dmg" ]]; then
    cp "$dmg" "dist/AI Token League${suffix}.dmg"
    inject_readme_into_dmg "dist/AI Token League${suffix}.dmg"
  fi

  # Updater package (.app.tar.gz + .sig)
  local tarball
  tarball=$(find "$target_dir" -name "*.app.tar.gz" 2>/dev/null | head -1)
  if [[ -n "$tarball" ]]; then
    local sig="${tarball}.sig"
    cp "$tarball" "dist/AI Token League${suffix}.app.tar.gz"
    [[ -f "$sig" ]] && cp "$sig" "dist/AI Token League${suffix}.app.tar.gz.sig"
  fi
}

collect_win_artifacts() {
  local rust_target="${1:-x86_64-pc-windows-msvc}"
  local bundle_dir
  bundle_dir="$(resolve_bundle_dir "$rust_target")"
  local nsis_dir="$bundle_dir/nsis"
  local msi_dir="$bundle_dir/msi"

  # NSIS installer
  local nsis
  nsis=$(find "$nsis_dir" -name "*setup*.exe" 2>/dev/null | head -1)
  if [[ -n "$nsis" ]]; then
    cp "$nsis" dist/
  fi

  # MSI installer
  local msi
  msi=$(find "$msi_dir" -name "*.msi" 2>/dev/null | head -1)
  if [[ -n "$msi" ]]; then
    cp "$msi" dist/
  fi

  # Updater NSIS zip
  local nsis_zip
  nsis_zip=$(find "$nsis_dir" -name "*.nsis.zip" 2>/dev/null | head -1)
  if [[ -n "$nsis_zip" ]]; then
    cp "$nsis_zip" dist/
    local sig="${nsis_zip}.sig"
    [[ -f "$sig" ]] && cp "$sig" dist/
  fi
}

case "$PLATFORM" in
  mac-arm64|current)
    if [[ "$(uname -s)" == "Darwin" ]]; then
      collect_mac_artifacts "arm64" "aarch64-apple-darwin"
    else
      collect_win_artifacts
    fi
    ;;
  mac-intel)   collect_mac_artifacts "x64" "x86_64-apple-darwin" ;;
  mac-all)
    collect_mac_artifacts "arm64" "aarch64-apple-darwin"
    collect_mac_artifacts "x64" "x86_64-apple-darwin"
    ;;
  win)         collect_win_artifacts ;;
  all)
    if [[ "$(uname -s)" == "Darwin" ]]; then
      collect_mac_artifacts "arm64" "aarch64-apple-darwin"
      collect_mac_artifacts "x64" "x86_64-apple-darwin"
    else
      collect_win_artifacts
    fi
    ;;
esac

set -e

# upload
if [[ "$UPLOAD" == "yes" ]]; then
  echo ">>> Uploading to OSS..."
  node scripts/publish-release.js --env "$ENV_FILE"
fi

# Clean up Tauri build targets to save disk space
echo ">>> Cleaning build targets..."
for target_dir in src-tauri/target/aarch64-apple-darwin src-tauri/target/x86_64-apple-darwin src-tauri/target/x86_64-pc-windows-msvc src-tauri/target/release; do
  if [[ -d "$target_dir" ]]; then
    rm -rf "$target_dir"
    echo "  Removed $target_dir"
  fi
done

# summary
echo ""
echo "=== Release Complete ==="
echo ""
echo "Artifacts:"
ls -lh dist/*.dmg dist/*.app.tar.gz dist/*.app.tar.gz.sig dist/*.exe dist/*.msi dist/*.nsis.zip 2>/dev/null || true
for d in dist/*.app; do [[ -d "$d" ]] && echo "  $(basename "$d")  ($(du -sh "$d" | cut -f1))"; done
echo ""
echo "Done."
