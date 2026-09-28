#!/usr/bin/env bash
set -uo pipefail

# Capture device evidence before the iPad kills its WebView content process.
#
# The process that dies is the one that would have to report its own death, and
# iOS keeps crash reports on the device. So this watches the samples the app
# posts to /api/pwa-log and fires a sysdiagnose while memory pressure is still
# building. A sysdiagnose is the only instrument that carries per-process
# footprints, and it must start before the kill, because afterwards the memory
# is already released.
#
# Archives land on oni under /tmp/ipad-captures/<stamp>/ with the recent device
# crash reports beside them, and every capture logs one line to the journal with
# tag ipad-capture.

DEVICE_UDID=00008030-001145142260C02E
TAG=ipad-capture
FREE_FLOOR_MB=900
COOLDOWN_S=1200
CAPTURE_ROOT=/tmp/ipad-captures
LOG=/home/ryan/.cache/orchestrel-ipad-capture.log

last_capture=0

say() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"
  logger -t "$TAG" "$*" || true
}

# Pull the Jet samEvent and cpu_resource reports that iOS wrote for this device.
pull_reports() {
  local stamp=$1
  ssh oni 'zsh -lic "bash -s"' <<REMOTE >>"$LOG" 2>&1 || true
export PATH=/opt/homebrew/bin:\$PATH
D=$DEVICE_UDID
OUT=$CAPTURE_ROOT/$stamp/reports
mkdir -p "\$OUT"
xcrun devicectl device info files --device \$D --domain-type systemCrashLogs 2>/dev/null |
  awk '{print \$1}' |
  grep -E '^(JetsamEvent|com.apple.WebKit.WebContent)' |
  tail -8 |
  while read -r f; do
    xcrun devicectl device copy from --device \$D --domain-type systemCrashLogs --source "\$f" --destination "\$OUT/\$(basename "\$f")" >/dev/null 2>&1 || true
  done
ls -1 "\$OUT" | tail -5
REMOTE
}

capture() {
  local free_mb=$1
  local warn=$2
  local now stamp
  now=$(date +%s)
  if (( now - last_capture < COOLDOWN_S )); then
    return
  fi
  last_capture=$now
  stamp=$(date -u +%Y%m%d-%H%M%S)
  say "pressure seen (free=${free_mb}MB warn=${warn}) - capturing $stamp"
  if ssh oni "zsh -lic 'xcrun devicectl device sysdiagnose --device $DEVICE_UDID --destination $CAPTURE_ROOT/$stamp'" >>"$LOG" 2>&1; then
    say "sysdiagnose captured at oni:$CAPTURE_ROOT/$stamp"
  else
    say "sysdiagnose failed for $stamp (device offline or locked?)"
  fi
  pull_reports "$stamp"
  say "capture complete at oni:$CAPTURE_ROOT/$stamp"
}

say "watching for iPad memory pressure (free < ${FREE_FLOOR_MB}MB or any warning)"

journalctl -u orchestrel -f --no-pager -o cat | while read -r line; do
  case "$line" in
    *"mem sid="*"iosTotal=2940MB"*|*"mem-native"*) ;;
    *) continue ;;
  esac

  free_mb=$(printf '%s' "$line" | grep -oE 'sysFree=[0-9]+|free=[0-9]+MB' | head -1 | grep -oE '[0-9]+' || true)
  warn=$(printf '%s' "$line" | grep -oE 'iosWarn=[0-9]+|warn=[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
  if [ -z "$free_mb" ]; then
    continue
  fi

  if (( free_mb < FREE_FLOOR_MB )) || (( ${warn:-0} > 0 )); then
    capture "$free_mb" "${warn:-0}"
  fi
done
