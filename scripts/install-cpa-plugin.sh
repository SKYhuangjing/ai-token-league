#!/usr/bin/env bash
# Install the AI Token League compute-sharing plugin (atl-share) into a local
# CLIProxyAPI (CPA) instance.
#
# Usage:
#   scripts/install-cpa-plugin.sh --api https://atl.example.com [options]
#
# Options:
#   --api <url>        ATL backend base URL (also lives in the CPA config
#                      snippet below; the plugin reads it from CPA config)
#   --plugin-dir <d>   CPA plugins directory (default: ~/.cli-proxy-api/plugins)
#   --title <name>     share title shown to borrowers (optional)
#   --budget <n>       daily window token pool (optional, default backend 1M)
#   --max-claims <n>   concurrent claim keys (optional, default 5)
#   --identity-dir <d> ATL data dir holding the league identity config.json
#                      (optional; default ~/.ai-token-league, ATL_HOME honored)
#   --force            overwrite an existing atl-share dylib
#
# The plugin file NAME is its CPA plugin id (atl-share.dylib). After install,
# make sure CPA's config.yaml carries:
#
#   plugins:
#     enabled: true
#     dir: "<plugin-dir>"
#     configs:
#       atl-share:
#         enabled: true
#         api: "<api url>"        # required — sharing stays off until set
#         # title: "my share"     # optional
#         # budget: 1000000       # optional owner policy knobs
#         # maxClaims: 5
#
# CPA hot-reloads config edits; a freshly added plugin file needs one restart.

set -euo pipefail
cd "$(dirname "$0")/.."

API_URL=""
PLUGIN_DIR="$HOME/.cli-proxy-api/plugins"
TITLE=""
BUDGET=""
MAX_CLAIMS=""
IDENTITY_DIR=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API_URL="${2:-}"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --budget) BUDGET="${2:-}"; shift 2 ;;
    --max-claims) MAX_CLAIMS="${2:-}"; shift 2 ;;
    --identity-dir) IDENTITY_DIR="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

echo "==> building cpa-plugin (release)"
cargo build --release --manifest-path cpa-plugin/Cargo.toml

DYLIB="cpa-plugin/target/release/libatl_share_cpa_plugin.dylib"
[[ -f "$DYLIB" ]] || { echo "build output missing: $DYLIB" >&2; exit 1; }

TARGET="$PLUGIN_DIR/atl-share.dylib"
if [[ -f "$TARGET" && "$FORCE" -ne 1 ]]; then
  echo "==> existing $TARGET found (use --force to overwrite); leaving it in place"
else
  mkdir -p "$PLUGIN_DIR"
  cp "$DYLIB" "$TARGET"
  echo "==> installed $TARGET"
fi

EXTRA=""
[[ -n "$TITLE" ]] && EXTRA="${EXTRA}      title: \"$TITLE\"
"
[[ -n "$BUDGET" ]] && EXTRA="${EXTRA}      budget: $BUDGET
"
[[ -n "$MAX_CLAIMS" ]] && EXTRA="${EXTRA}      maxClaims: $MAX_CLAIMS
"
[[ -n "$IDENTITY_DIR" ]] && EXTRA="${EXTRA}      identityDir: \"$IDENTITY_DIR\"
"

printf '==> add this to CPA config.yaml (then restart CPA once for the new file):

plugins:
  enabled: true
  dir: "%s"
  configs:
    atl-share:
      enabled: true
' "$PLUGIN_DIR"
if [[ -n "$API_URL" ]]; then
  printf '      api: "%s"\n' "$API_URL"
fi
printf '%s' "$EXTRA"

cat <<'LISTEN_NOTE'

==> borrowers reach the share through CPA itself, so CPA must listen on the
    LAN for sharing to work. In the same config.yaml:

      host: 0.0.0.0        # default empty also binds all interfaces

    WARNING: this exposes the WHOLE CPA (management API stays key-guarded),
    not just the share. Pair it with an intranet/VPN. The atl-share plugin
    detects the mismatch (LAN baseURL + loopback bind) and reports it in the
    card; it never changes the bind itself — that is the owner's call.
LISTEN_NOTE

cat <<'FOOTER'

==> plugin state (identity/ledger) lives in ~/.ai-token-league/cpa-plugin/
    (or $ATL_HOME/cpa-plugin when overridden). Stop sharing = set
    atl-share.enabled: false in CPA config (hot reload) — every temp key
    dies immediately while the owner's builtin keys keep working.
FOOTER
