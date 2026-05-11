#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- defaults (interactive mode will override) ---
VERSION=""
PLATFORM=""
ENV_FILE=""
INSTALLERS=""
UPLOAD=""
AUTO_YES=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Interactive release builder for AI Token League.
Without flags, runs in interactive mode with prompts.

Options:
  --version VER     Version to release (default: current from package.json)
  --platform PLAT   Platform: current | mac-arm64 | mac-intel | mac-all | win | all (default: all)
  --env FILE        Env file for presets and upload credentials
  --installers      Build native installers (DMG / NSIS)
  --upload          Upload artifacts to OSS after build; builds all platforms and installers
  --yes             Skip confirmation prompt
  -h, --help        Show this help message

Examples:
  $(basename "$0")                                      # fully interactive
  $(basename "$0") --platform current --yes             # quick current-machine zip
  $(basename "$0") --platform mac-arm64 --yes           # quick mac-arm64 build
  $(basename "$0") --version 0.6.0 --upload --yes      # bump + build + upload
  $(basename "$0") --env env.prod --installers --upload # full release with env
EOF
  exit 0
}

# --- parse CLI flags ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     VERSION="$2"; shift 2 ;;
    --platform)    PLATFORM="$2"; shift 2 ;;
    --env)         ENV_FILE="$2"; shift 2 ;;
    --installers)  INSTALLERS="yes"; shift ;;
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

# --- check Node.js ---
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "Error: Node.js >= 22 required, found $(node -v)"
  exit 1
fi

# --- read current version ---
CURRENT_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

echo ""
echo "=== AI Token League Release Builder ==="
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
  # resolve relative path
  [[ "$ENV_FILE" != /* ]] && ENV_FILE="$PROJECT_ROOT/$ENV_FILE"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "  Warning: env file not found: $ENV_FILE"
    ENV_FILE=""
  else
    echo "  Env file: $ENV_FILE"
  fi
fi

# --- step 4: installers ---
if [[ -z "$INSTALLERS" ]]; then
  prompt_yn INSTALLERS "  Build native installers (DMG/NSIS)? [y/N] " "no"
fi

# --- step 5: upload ---
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
if [[ "$UPLOAD" == "yes" && "$INSTALLERS" != "yes" ]]; then
  echo "  Upload requires installer artifacts; enabling installers."
  INSTALLERS="yes"
fi
echo "  Installers: $INSTALLERS"
echo "  Upload: $UPLOAD"

# --- step 6: confirm ---
echo ""
echo "  --- Summary ---"
echo "  Version:    $VERSION"
echo "  Platform:   $PLATFORM_LABEL"
echo "  Env file:   ${ENV_FILE:-none}"
echo "  Installers: $INSTALLERS"
echo "  Upload:     $UPLOAD"
echo ""

if [[ "$AUTO_YES" != true ]]; then
  read -rp "  Proceed? [Y/n] " confirm
  case "$confirm" in
    n|N|no) echo "Aborted."; exit 0 ;;
  esac
fi

# --- execute pipeline ---
echo ""
echo ">>> Cleaning dist/ and dist-installer/..."
rm -rf dist dist-installer

# preset
if [[ -n "$ENV_FILE" ]]; then
  echo ">>> Writing preset from $ENV_FILE..."
  node scripts/build-preset.js --env "$ENV_FILE"
else
  echo ">>> No env file, writing empty preset..."
  node scripts/build-preset.js
fi

# packaging
run_package() {
  case "$1" in
    mac-arm64)  npm run package:mac:arm64 ;;
    mac-intel)  npm run package:mac:intel ;;
    mac-all)    npm run package:mac:all ;;
    win)        npm run package:win ;;
    all)        npm run package:all; return ;;
  esac
  # for single platforms (except "all" which already zips), run zip
  if [[ "$1" != "all" ]]; then
    node scripts/zip-dist.js
  fi
}

echo ">>> Packaging $PLATFORM_LABEL..."
run_package "$PLATFORM"

# installers
if [[ "$INSTALLERS" == "yes" ]]; then
  echo ">>> Building native installers..."
  case "$PLATFORM" in
    mac-arm64)  npm run package:installer:mac:arm64 ;;
    mac-intel)  npm run package:installer:mac:intel ;;
    mac-all)    npm run package:installer:mac:all ;;
    win)        npm run package:installer:win ;;
    all)        npm run package:installer:all ;;
  esac
fi

# upload
if [[ "$UPLOAD" == "yes" ]]; then
  echo ">>> Uploading to OSS..."
  node scripts/publish-release.js --env "$ENV_FILE"
fi

# summary
echo ""
echo "=== Release Complete ==="
echo ""
echo "Artifacts:"
ls -lh dist/*.zip 2>/dev/null || true
ls -lh dist-installer/* 2>/dev/null || true
echo ""
echo "Done."
