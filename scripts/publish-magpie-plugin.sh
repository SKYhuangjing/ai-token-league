#!/usr/bin/env bash
# Rebuild the magpie-plugin-dist orphan branch from magpie-plugin/ (contents at
# repo root — Magpie's git install resolves the repo-root entry and does not
# support subdirectories) for GitHub-based plugin distribution.
#
# Usage:
#   scripts/publish-magpie-plugin.sh            # rebuild dist branch locally
#   PUSH=1 scripts/publish-magpie-plugin.sh     # rebuild and push to GitHub (SSH)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${BRANCH:-magpie-plugin-dist}"
REMOTE="${REMOTE:-git@github.com:SKYhuangjing/ai-token-league.git}"

if [ ! -f "$ROOT/magpie-plugin/package.json" ]; then
  echo "error: magpie-plugin/package.json not found" >&2
  exit 1
fi

WORKTREE="$(mktemp -d /tmp/atl-magpie-dist.XXXXXX)"
trap 'git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true' EXIT

git -C "$ROOT" worktree add --detach "$WORKTREE" HEAD >/dev/null
cd "$WORKTREE"
git checkout --orphan "$BRANCH" >/dev/null 2>&1 || git checkout "$BRANCH"
git rm -rf --quiet . >/dev/null 2>&1 || true

cp -R "$ROOT/magpie-plugin/" .
# never ship runtime bridge artifacts, dev tooling or local junk (the
# community plugin convention: the runtime surface + README only)
rm -f page/status.js page/usage-data.js
rm -rf node_modules .tmp .tmp-smoke test doc .gitignore

git add -A
VERSION="$(node -p "require('./package.json').version")"
# a re-run with unchanged content has nothing to commit; that must not stop
# the script before its push (set -e would), so the empty commit is tolerated
git -c user.name="atl-release" -c user.email="release@localhost" \
  commit --quiet -m "magpie-atl-sync dist v${VERSION} (from magpie-plugin/ at $(git -C "$ROOT" rev-parse --short HEAD))" || true

echo "dist branch '$BRANCH' rebuilt at v$VERSION:"
git log --oneline -1
git ls-files | head -20

if [ "${PUSH:-0}" = "1" ]; then
  git push -f "$REMOTE" "$BRANCH"
  echo "pushed: $REMOTE $BRANCH"
  echo "install with: magpie plugin add github:SKYhuangjing/ai-token-league#$BRANCH"
else
  echo "dry run only — set PUSH=1 to push to $REMOTE"
fi

# NPM mode: pack the same trimmed runtime surface as a tarball and (with
# NPM_PUBLISH=1) publish it — npm is the install path Magpie tries first.
if [ "${NPM:-0}" = "1" ]; then
  cd "$ROOT/magpie-plugin"
  npm pack
  if [ "${NPM_PUBLISH:-0}" = "1" ]; then
    npm publish "magpie-atl-sync-$(node -p "require('./package.json').version").tgz"
    echo "published — install with: magpie plugin add magpie-atl-sync"
  else
    echo "npm dry run only — set NPM_PUBLISH=1 to publish to the registry"
  fi
fi
