#!/usr/bin/env bash
# Package one platform of the desktop app into desktop/dist/ (and optionally
# a GitHub release). Single purpose; no subscripts.
#
# Usage:
#   scripts/package-desktop.sh --target linux|mac|win --version X.Y.Z [--release] [--publish]
#
# Flow: stamp desktop/package.json's version -> bun run build (SPA) ->
# build-bundles.mjs (node runtime + sqlite prebuild for the target platform)
# -> build-main.mjs -> electron-builder with the target's yml. With
# --release, additionally `gh release create vX.Y.Z <artifacts>` (draft by
# default; --publish promotes it to a public release, which is what makes the
# update feed live). GH_TOKEN must be in the environment for --release.
set -ex

TARGET=
VERSION=
RELEASE=0
PUBLISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$TARGET" ] && [ -n "$VERSION" ] || {
  echo "usage: $0 --target linux|mac|win --version X.Y.Z [--release] [--publish]" >&2
  exit 1
}
case "$TARGET" in linux|mac|win) ;; *) echo "bad --target: $TARGET" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESK="$ROOT/desktop"

# The builder's OUTPUT dir is desktop/release/ (see the ymls' directories.output)
# so it can never be picked up by files: dist/** — that collision used to
# pack previous builds' AppImages into the new asar. Clearing it here anyway
# keeps repeated same-version runs deterministic.
rm -rf "$DESK/release" 2>/dev/null || true

# One version number in desktop/package.json stamps the artifact names, the
# electron-builder yml output, and the latest*.yml feed files.
node -e '
const fs = require("fs");
const p = process.argv[1], v = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.version = v;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$DESK/package.json" "$VERSION"

# SPA build (build/client) feeds out/client in the bundle step.
(cd "$ROOT" && bun run build)

# The bundle is platform-independent JS; what varies is the embedded runtime:
# node tarball + better-sqlite3 prebuild for the target, and the flat node
# binary name (node.exe for win-x64 even on a linux builder). build-main runs
# FIRST: build-bundles copies dist/provision-dll-bundle.cjs, which only
# build-main produces.
PLATFORM_CASE=""
case "$TARGET" in
  linux)
    PLATFORM_CASE=""
    echo "NOTE: --target linux packages BOTH x64 and arm64; the embedded node/sqlite runtime in out/ is built for the HOST arch, so smoke-test the x64 artifact on an x64 box and arm64 on an arm64 box (or re-run bundles with --platform linux-arm64 to swap the runtime)."
    ;;
  mac) PLATFORM_CASE="mac-arm64" ;;
  win) PLATFORM_CASE="win-x64" ;;
esac
(cd "$DESK" && node build-main.mjs)
if [ -n "$PLATFORM_CASE" ]; then
  (cd "$DESK" && node build-bundles.mjs --platform "$PLATFORM_CASE")
else
  (cd "$DESK" && node build-bundles.mjs)
fi

ARTGLOB=""
(cd "$DESK" && npx electron-builder --config "electron-builder-$TARGET.yml" --publish never)

# Collect the artifacts electron-builder emitted for this version. Artifact
# names differ per format (Orchestrel-* for AppImage/dmg, *Setup* for the
# win nsis exe, orchestrel-desktop_* for deb), so match both spellings.
ARTS=()
while IFS= read -r -d '' a; do ARTS+=("$a"); done < <(find "$DESK/release" \( -name "Orchestrel*$VERSION*" -o -name "Orchestrel Setup $VERSION*" -o -name "orchestrel-desktop_${VERSION}_*" \) -print0 | sort -z)
if [ ${#ARTS[@]} -eq 0 ]; then echo "no artifacts found for version $VERSION in $DESK/dist" >&2; exit 1; fi
if [ "$RELEASE" = "1" ]; then
  [ -n "${GH_TOKEN:-}" ] || { echo "GH_TOKEN required for --release" >&2; exit 1; }
  GH_ARGS=()
  if [ "$PUBLISH" != "1" ]; then GH_ARGS+=(--draft); fi
  gh release create "v$VERSION" "${ARTS[@]}" --title "Orchestrel $VERSION" --notes "Desktop app $VERSION" "${GH_ARGS[@]}"
else
  echo "skipping --release; artifacts:"
  printf '%s\n' "${ARTS[@]}"
fi
