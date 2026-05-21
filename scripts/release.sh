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

TAURI_BUNDLE_BASE="target"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Interactive release builder for AI Token League (Tauri).
Without flags, runs in interactive mode with prompts.

Options:
  --version VER     Version to release (default: current from package.json)
  --platform PLAT   Platform: current | mac-arm64 | mac-intel | mac-all | win | linux | all (default: all)
  --env FILE        Env file for presets and upload credentials
  --upload          Upload artifacts to OSS after build. Single-platform builds publish platform parts; all-platform builds publish final metadata.
  --yes             Skip confirmation prompt
  -h, --help        Show this help message

Examples:
  $(basename "$0")                                      # fully interactive
  $(basename "$0") --platform current --yes             # quick current-machine build
  $(basename "$0") --platform mac-arm64 --yes           # quick mac-arm64 build
  $(basename "$0") --version 0.6.0 --upload --yes      # bump + build + upload
  $(basename "$0") --env env.prod --upload              # full release with env
  node scripts/publish-release.js --env env.prod --finalize  # merge uploaded platform parts
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
    Linux:x86_64)  echo "linux" ;;
    *)
      echo "Error: unsupported current platform: $os $arch" >&2
      echo "Use --platform mac-arm64, mac-intel, mac-all, win, linux, or all." >&2
      exit 1
      ;;
  esac
}

# --- configure MSVC environment on Windows (Git Bash) ---
configure_msvc_env() {
  [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]] && return 0

  # If MSVC linker is already on PATH and LIB is set, skip
  local msvc_link
  msvc_link="$(command -v link.exe 2>/dev/null || true)"
  if [[ -n "$msvc_link" && -n "${LIB:-}" ]]; then
    return 0
  fi

  echo ">>> Configuring MSVC build environment..."

  # Find latest MSVC tools
  local msvc_base=""
  local msvc_dir="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
  [[ ! -d "$msvc_dir" ]] && msvc_dir="/c/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
  [[ ! -d "$msvc_dir" ]] && msvc_dir="/c/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC"
  [[ ! -d "$msvc_dir" ]] && msvc_dir="/c/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC"
  [[ ! -d "$msvc_dir" ]] && msvc_dir="/c/Program Files (x86)/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC"

  if [[ -d "$msvc_dir" ]]; then
    msvc_base="$(ls -1d "$msvc_dir"/*/ 2>/dev/null | sort -V | tail -1)"
    msvc_base="${msvc_base%/}"
  fi

  if [[ -z "$msvc_base" || ! -f "$msvc_base/bin/Hostx64/x64/link.exe" ]]; then
    echo "Error: MSVC linker not found. Run scripts/setup-build-env-windows.ps1 first."
    exit 1
  fi

  # Find latest Windows SDK
  local sdk_base=""
  local sdk_dir="/c/Program Files (x86)/Windows Kits/10/Lib"
  if [[ -d "$sdk_dir" ]]; then
    local sdk_ver
    sdk_ver="$(ls -1 "$sdk_dir" 2>/dev/null | sort -V | tail -1)"
    if [[ -n "$sdk_ver" && -f "$sdk_dir/$sdk_ver/ucrt/x64/ucrt.lib" ]]; then
      sdk_base="$sdk_dir/$sdk_ver"
    fi
  fi

  if [[ -z "$sdk_base" ]]; then
    echo "Error: Windows SDK not found. Install it via Visual Studio Installer (Windows 10 SDK)."
    exit 1
  fi

  # Convert to Windows-style backslash paths for MSVC tools
  local msvc_lib="${msvc_base//\//\\}\\lib\\x64"
  local msvc_atl_lib="${msvc_base//\//\\}\\atlmfc\\lib\\x64"
  local sdk_ucrt_lib="${sdk_base//\//\\}\\ucrt\\x64"
  local sdk_um_lib="${sdk_base//\//\\}\\um\\x64"
  local msvc_include="${msvc_base//\//\\}\\include"
  local sdk_ucrt_include="${sdk_base//\//\\}/../Include/${sdk_ver}/ucrt"
  local sdk_shared_include="${sdk_base//\//\\}/../Include/${sdk_ver}/shared"
  local sdk_um_include="${sdk_base//\//\\}/../Include/${sdk_ver}/um"

  export PATH="$msvc_base/bin/Hostx64/x64:$PATH"
  export LIB="$msvc_lib;$msvc_atl_lib;$sdk_ucrt_lib;$sdk_um_lib"
  export INCLUDE="$msvc_include;$sdk_ucrt_include;$sdk_shared_include;$sdk_um_include"

  echo "  MSVC: $msvc_base"
  echo "  SDK:  $(basename "$sdk_base")"
}
configure_msvc_env

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
  echo "    5) Linux x64"
  echo "    6) All platforms"
  echo "    7) Current machine"
  echo ""
  prompt PLATFORM "Select platform [6]: " "6"
fi

case "$PLATFORM" in
  7|current)    PLATFORM="$(detect_current_platform)" ;;
esac

case "$PLATFORM" in
  1|mac-arm64)  PLATFORM="mac-arm64";  PLATFORM_LABEL="macOS arm64" ;;
  2|mac-intel)  PLATFORM="mac-intel";  PLATFORM_LABEL="macOS Intel" ;;
  3|mac-all)    PLATFORM="mac-all";    PLATFORM_LABEL="macOS All" ;;
  4|win)        PLATFORM="win";        PLATFORM_LABEL="Windows x64" ;;
  5|linux)      PLATFORM="linux";      PLATFORM_LABEL="Linux x64" ;;
  6|all)        PLATFORM="all";        PLATFORM_LABEL="All platforms" ;;
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

# preset + export env vars (TAURI_SIGNING_PRIVATE_KEY, etc.)
if [[ -n "$ENV_FILE" ]]; then
  echo ">>> Writing preset from $ENV_FILE..."
  node scripts/build-preset.js --env "$ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
  # Load signing key for Tauri updater
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    key_path="$PROJECT_ROOT/src-tauri/.signing-key"
    if [[ -f "$key_path" ]]; then
      export TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_path")"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
      echo "  Using signing key: $key_path"
    fi
  fi
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

collector_binary_name_for_target() {
  local rust_target="$1"
  case "$rust_target" in
    *windows*) echo "atl-collector.exe" ;;
    *)         echo "atl-collector" ;;
  esac
}

current_host_can_build_target() {
  local rust_target="$1"
  local host_os host_arch
  host_os="$(uname -s)"
  host_arch="$(uname -m)"
  case "$rust_target" in
    x86_64-pc-windows-msvc)
      [[ "$host_os" == MINGW* || "$host_os" == MSYS* || "$host_os" == CYGWIN* || "${OS:-}" == "Windows_NT" ]]
      ;;
    x86_64-unknown-linux-gnu)
      [[ "$host_os" == "Linux" ]]
      ;;
    aarch64-apple-darwin)
      [[ "$host_os" == "Darwin" ]]
      ;;
    x86_64-apple-darwin)
      [[ "$host_os" == "Darwin" ]]
      ;;
    *)
      [[ "$host_arch" == "$host_arch" ]]
      ;;
  esac
}

prepare_collector_binary() {
  local rust_target="$1"
  local label="$2"
  local binary_name built_binary staged_binary

  binary_name="$(collector_binary_name_for_target "$rust_target")"
  built_binary="$PROJECT_ROOT/target/$rust_target/release/$binary_name"
  staged_binary="$PROJECT_ROOT/src-tauri/binaries/$binary_name"

  mkdir -p "$PROJECT_ROOT/src-tauri/binaries"
  rm -f "$PROJECT_ROOT"/src-tauri/binaries/atl-collector "$PROJECT_ROOT"/src-tauri/binaries/atl-collector.exe

  if ! current_host_can_build_target "$rust_target"; then
    echo "  Warning: skipping atl-collector build for $label on this host; build that platform natively before publishing it."
    return 0
  fi

  echo ">>> Building atl-collector for $label..."
  cargo build --release -p atl-collector --target "$rust_target"

  if [[ ! -f "$built_binary" ]]; then
    echo "Error: collector binary not found after build: $built_binary"
    exit 1
  fi

  cp "$built_binary" "$staged_binary"
  chmod +x "$staged_binary" || true
}

# Tauri build
# Cross-compilation notes:
#   - macOS targets are built with the full bundle set first so Apple Silicon hosts can produce Intel DMGs.
#   - If cross-target DMG packaging fails but the .app exists, retry app-only to keep updater artifacts available.
#   - Windows must be built natively on Windows (ring/cross-deps don't cross-compile).
run_tauri_build() {
  local native_arch
  native_arch="$(uname -m)"

  build_mac_target() {
    local rust_target="$1"
    local arch_label="$2"
    local exit_code=0
    prepare_collector_binary "$rust_target" "$arch_label"
    if [[ "$native_arch" == "arm64" && "$rust_target" == "aarch64-apple-darwin" ]] || \
       [[ "$native_arch" == "x86_64" && "$rust_target" == "x86_64-apple-darwin" ]]; then
      echo ">>> Building $arch_label (native)..."
      npx tauri build --target "$rust_target" || exit_code=$?
    else
      echo ">>> Building $arch_label (cross, full bundle)..."
      npx tauri build --target "$rust_target" || exit_code=$?
      if [[ $exit_code -ne 0 ]]; then
        local bundle_dir
        bundle_dir="$(resolve_bundle_dir "$rust_target")"
        if [[ -d "$bundle_dir/macos/AI Token League.app" ]]; then
          echo "  Warning: full cross bundle failed for $arch_label; retrying app-only so updater artifacts remain available."
          exit_code=0
          npx tauri build --target "$rust_target" --bundles app || exit_code=$?
        fi
      fi
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
      echo ">>> Building Windows x64..."
      prepare_collector_binary x86_64-pc-windows-msvc "Windows x64"
      npx tauri build --target x86_64-pc-windows-msvc || true
      ;;
    linux)
      echo ">>> Building Linux x64..."
      prepare_collector_binary x86_64-unknown-linux-gnu "Linux x64"
      npx tauri build --target x86_64-unknown-linux-gnu || true
      ;;
    mac-all)
      build_mac_target aarch64-apple-darwin "macOS arm64"
      build_mac_target x86_64-apple-darwin "macOS Intel"
      ;;
    all)
      build_mac_target aarch64-apple-darwin "macOS arm64"
      build_mac_target x86_64-apple-darwin "macOS Intel"
      echo ">>> Building Windows x64 (cross)..."
      prepare_collector_binary x86_64-pc-windows-msvc "Windows x64"
      npx tauri build --target x86_64-pc-windows-msvc || true
      echo ">>> Building Linux x64 (cross)..."
      prepare_collector_binary x86_64-unknown-linux-gnu "Linux x64"
      npx tauri build --target x86_64-unknown-linux-gnu || true
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
    if ! scripts/patch-dmg-readme.sh --dmg "dist/AI Token League${suffix}.dmg"; then
      echo "Error: failed to inject mac-install-readme.txt into dist/AI Token League${suffix}.dmg"
      exit 1
    fi
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

collect_linux_artifacts() {
  local rust_target="${1:-x86_64-unknown-linux-gnu}"
  local bundle_dir
  bundle_dir="$(resolve_bundle_dir "$rust_target")"
  local appimage_dir="$bundle_dir/appimage"
  local deb_dir="$bundle_dir/deb"

  # AppImage
  local appimage
  appimage=$(find "$appimage_dir" -name "*.AppImage" 2>/dev/null | head -1)
  if [[ -n "$appimage" ]]; then
    cp "$appimage" dist/
  fi

  # AppImage updater tarball + sig
  local tarball
  tarball=$(find "$appimage_dir" -name "*.AppImage.tar.gz" 2>/dev/null | head -1)
  if [[ -n "$tarball" ]]; then
    cp "$tarball" dist/
    local sig="${tarball}.sig"
    [[ -f "$sig" ]] && cp "$sig" dist/
  fi

  # .deb package
  local deb
  deb=$(find "$deb_dir" -name "*.deb" 2>/dev/null | head -1)
  if [[ -n "$deb" ]]; then
    cp "$deb" dist/
  fi
}

case "$PLATFORM" in
  current)
    if [[ "$(uname -s)" == "Darwin" ]]; then
      collect_mac_artifacts "arm64" "aarch64-apple-darwin"
    elif [[ "$(uname -s)" == "Linux" ]]; then
      collect_linux_artifacts
    else
      collect_win_artifacts
    fi
    ;;
  mac-arm64)   collect_mac_artifacts "arm64" "aarch64-apple-darwin" ;;
  mac-intel)   collect_mac_artifacts "x64" "x86_64-apple-darwin" ;;
  mac-all)
    collect_mac_artifacts "arm64" "aarch64-apple-darwin"
    collect_mac_artifacts "x64" "x86_64-apple-darwin"
    ;;
  win)         collect_win_artifacts ;;
  linux)       collect_linux_artifacts ;;
  all)
    collect_mac_artifacts "arm64" "aarch64-apple-darwin"
    collect_mac_artifacts "x64" "x86_64-apple-darwin"
    collect_win_artifacts
    collect_linux_artifacts
    ;;
esac

set -e

rm -f src-tauri/binaries/atl-collector src-tauri/binaries/atl-collector.exe

# upload
if [[ "$UPLOAD" == "yes" ]]; then
  echo ">>> Uploading to OSS..."
  if [[ "$PLATFORM" == "all" ]]; then
    node scripts/publish-release.js --env "$ENV_FILE"
  else
    node scripts/publish-release.js --env "$ENV_FILE" --part
    echo "  Uploaded platform part metadata. Run finalize after all build hosts finish:"
    echo "  node scripts/publish-release.js --env \"$ENV_FILE\" --finalize"
  fi
fi

# Clean up Tauri build targets to save disk space
echo ">>> Cleaning build targets..."
for target_dir in target/aarch64-apple-darwin target/x86_64-apple-darwin target/x86_64-pc-windows-msvc target/x86_64-unknown-linux-gnu target/release src-tauri/target; do
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
ls -lh dist/*.dmg dist/*.app.tar.gz dist/*.app.tar.gz.sig dist/*.exe dist/*.msi dist/*.nsis.zip dist/*.AppImage dist/*.AppImage.tar.gz dist/*.AppImage.tar.gz.sig dist/*.deb 2>/dev/null || true
for d in dist/*.app; do [[ -d "$d" ]] && echo "  $(basename "$d")  ($(du -sh "$d" | cut -f1))"; done
echo ""
echo "Done."
