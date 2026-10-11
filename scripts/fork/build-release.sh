#!/usr/bin/env bash
# Build a stamped release from the current checkout and assemble it under
# /home/t3/.local/share/t3-source/releases/<short-sha>/.
#
# Refuses to build with uncommitted source changes so a release name always
# identifies an exact git commit (rollback = checkout that commit, per
# ROLLBACK.md). Uses the pinned toolchain because the repository's own vp
# cannot build apps/web (vite-plus-core version mismatch).
set -euo pipefail
cd "$(dirname "$0")/../.."

REL_ROOT=${T3_FORK_RELEASES:-/home/t3/.local/share/t3-source/releases}
TC=${T3_FORK_TOOLCHAIN:-/home/t3/.cache/t3-source-migration/toolchain}

DIRTY=$(git status --porcelain | grep -v $'\tM AGENTS.md' | grep -Ev '^\?\?' || true)
if [ -n "$DIRTY" ]; then
  echo "REFUSING: uncommitted changes would make the release name a lie:"
  echo "$DIRTY"
  echo "Commit first (AGENTS.md local edits are allowed)."
  exit 1
fi

SHA=$(git rev-parse --short HEAD)
DEST="$REL_ROOT/$SHA"
[ -d "$DEST" ] && { echo "release already exists: $DEST"; exit 0; }

export PATH="$TC/node-v24.13.1-linux-x64/bin:$TC/vite-plus-1.0.0/node_modules/.bin:$PATH"

node scripts/fork/stamp-build-version.mjs -- vp run --filter t3 build:bundle
( cd apps/web && vp build )

PREV=$(grep -o 'releases/[^/]*/bin.mjs' ~/.config/systemd/user/t3code-custom.service \
  | head -1 | cut -d/ -f2)
[ -d "$REL_ROOT/$PREV" ] || { echo "FATAL: no previous release ($PREV) to inherit externals"; exit 1; }

cp -a "$REL_ROOT/$PREV" "$DEST"
rm -f "$DEST"/*.mjs "$DEST"/*.mjs.map
cp apps/server/dist/*.mjs apps/server/dist/*.mjs.map "$DEST"/
rm -rf "$DEST/client"
cp -a apps/web/dist "$DEST/client"

echo "release ready: $DEST (from commit $SHA, stamped $SHA)"
echo "deploy with: scripts/fork/deploy-release.sh $SHA"
