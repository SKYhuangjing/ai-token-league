#!/usr/bin/env bash
# Publish magpie-atl-sync to npm — the install channel Magpie tries first
# (the old magpie-plugin-dist orphan branch is retired; git-source installs
# are not offered because Magpie resolves git plugins at the repo root).
#
# Usage:
#   scripts/publish-magpie-plugin.sh              # npm pack (dry run)
#   NPM_PUBLISH=1 scripts/publish-magpie-plugin.sh  # pack + npm publish
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$ROOT/magpie-plugin/package.json" ]; then
  echo "error: magpie-plugin/package.json not found" >&2
  exit 1
fi

cd "$ROOT/magpie-plugin"
npm pack
if [ "${NPM_PUBLISH:-0}" = "1" ]; then
  npm publish "magpie-atl-sync-$(node -p "require('./package.json').version").tgz"
  echo "published — install with: magpie plugin add magpie-atl-sync"
else
  echo "dry run only — set NPM_PUBLISH=1 to publish to the registry"
fi
