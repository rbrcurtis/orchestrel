#!/usr/bin/env bash
# launchd entrypoint for orcd: upgrade pi to latest, then start the daemon.
set -ex

cd "$(dirname "$0")/.."

# Best-effort: don't block orcd startup if the registry is unreachable
bun update @earendil-works/pi-coding-agent --latest || true

exec bun run orcd
