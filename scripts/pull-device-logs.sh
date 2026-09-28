#!/usr/bin/env bash
set -uo pipefail

# Pull the client logs that the clients cannot send.
#
# A renderer that dies cannot send its own last line, and these apps keep a local
# record for exactly that reason: the desktop app beside its own data, the iPad in
# its app container. Their reports through Cloudflare are unreliable, so this
# copies the records here and forwards new lines into this host's journal, which
# then holds the story for every client on one machine.

ONI=oni
DESKTOP_LOG='/Users/ryan/Library/Application Support/Orchestrel/orchestrel-desktop-metrics.log'
IOS_BUNDLE=com.orchestrel.ios
IOS_DEVICES=("ipad:00008030-001145142260C02E" "juno:294C9522-5D62-5E2D-A654-ECFD7092D36A")
CACHE=/home/ryan/.cache/orchestrel-device-logs
DESKTOP_STATE=$CACHE/desktop-metrics.log
TAG=device-log

mkdir -p "$CACHE"

forward() {
  local pulled=$1
  local state=$2
  local label=$3
  [ -s "$pulled" ] || return 0

  if [ -s "$state" ]; then
    comm -13 <(sort -u "$state") <(sort -u "$pulled") | while IFS= read -r line; do
      [ -n "$line" ] || continue
      logger -t "$TAG" "$label $line" || true
    done
  else
    # First run: the record already on the device is history worth keeping.
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      logger -t "$TAG" "$label $line" || true
    done <"$pulled"
  fi

  cp "$pulled" "$state"
}

# Desktop: flat file next to the app's own data, reachable over ssh.
if ssh "$ONI" "cat '$DESKTOP_LOG'" >"$CACHE/desktop-metrics.new" 2>/dev/null; then
  forward "$CACHE/desktop-metrics.new" "$DESKTOP_STATE" desktop
fi

# iPad and Juno: the app's container. devicectl can read it, and it works while
# the device is unlocked and on the network, which is also when the faults happen.
# A device that is asleep, or one that has not been given this build yet, simply
# produces nothing here.
for entry in "${IOS_DEVICES[@]}"; do
  name=${entry%%:*}
  udid=${entry#*:}
  remote=/tmp/${name}-native.log
  if ssh "$ONI" "zsh -lic 'xcrun devicectl device copy from --device $udid --domain-type appDataContainer --domain-identifier $IOS_BUNDLE --source Documents/orchestrel-native.log --destination $remote'" >/dev/null 2>&1; then
    if ssh "$ONI" "cat $remote" >"$CACHE/$name-native.new" 2>/dev/null; then
      forward "$CACHE/$name-native.new" "$CACHE/$name-native.log" "$name"
    fi
  fi
done
