// Pure-slice tests for the auto-updater: the 4-hour check cadence predicate
// and the channel-file name electron-updater actually fetches. The names are
// verified against electron-updater v6 source: Provider.getChannelFilePrefix()
// yields "-linux"/"-mac"/"" for the "latest" channel, so the released
// artifacts must carry those exact filenames (electron-updater 6.8.9,
// out/providers/Provider.js + util.getChannelFilename).
import { expect, test } from 'vitest'
import { CHECK_INTERVAL_MS, shouldCheck, updateFeedPath } from './updater'

test('shouldCheck is true when never checked, after the interval, and false inside it', () => {
  const now = Date.now()
  expect(shouldCheck(null, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS - 1, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS + 1, now, CHECK_INTERVAL_MS)).toBe(false)
  expect(shouldCheck(now - 60_000, now, CHECK_INTERVAL_MS)).toBe(false)
})

test('updateFeedPath names the per-platform yml correctly', () => {
  // x64 linux carries no arch suffix (Provider.js: "-linux" + archSuffix,
  // archSuffix === "" when x64).
  expect(updateFeedPath('1.2.3', 'linux-x64')).toBe('latest-linux.yml')
  expect(updateFeedPath('1.2.3', 'darwin-arm64')).toBe('latest-mac.yml')
  expect(updateFeedPath('1.2.3', 'win32-x64')).toBe('latest.yml')
})
