#!/usr/bin/env bash
set -ex
SRC="$(cd "$(dirname "$0")/.." && pwd)/extensions/claude-max"
DEST="${HOME}/.pi/agent/extensions/claude-max"
mkdir -p "${HOME}/.pi/agent/extensions"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
ls -la "$DEST"
