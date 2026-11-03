#!/usr/bin/env bash
# Builds release/Relay-<version>-arm64.dmg with the Relay Host app and the setup scripts bundled.
# Usage: bash scripts/package-onboarding.sh        (RELAY_REPO overrides the repo holding apps/mac-host)
set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_REPO="${RELAY_REPO:-$(cd "$DESKTOP/../.." && pwd)}"

VERSION="$(node -p "require('$DESKTOP/package.json').version")"
[ -n "$VERSION" ] || { echo "could not read version from package.json" >&2; exit 1; }
[ -d "$RELAY_REPO/apps/mac-host" ] || { echo "RELAY_REPO has no apps/mac-host: $RELAY_REPO" >&2; exit 1; }

echo "==> Building Relay Host $VERSION (--dist) in $RELAY_REPO"
(cd "$RELAY_REPO/apps/mac-host" && ./build.sh "$VERSION" --dist)

HOST_SRC="$RELAY_REPO/apps/mac-host/dist/Relay Host.app"
[ -d "$HOST_SRC" ] || { echo "missing $HOST_SRC" >&2; exit 1; }

DEST="$DESKTOP/resources/RelayHost"
echo "==> Copying Relay Host.app to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
ditto "$HOST_SRC" "$DEST/Relay Host.app"

echo "==> Building desktop and packaging dmg"
cd "$DESKTOP"
pnpm exec electron-vite build
pnpm exec electron-builder --mac dmg --arm64 --publish never

OUT="$DESKTOP/release/Relay-$VERSION-arm64.dmg"
[ -f "$OUT" ] || { echo "expected $OUT was not produced" >&2; exit 1; }
echo "==> Done: $OUT"
