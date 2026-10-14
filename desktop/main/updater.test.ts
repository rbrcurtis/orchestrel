// Pure-slice tests for the auto-updater: the 4-hour check cadence predicate.
// (The channel-file names electron-updater fetches — latest.yml / latest-linux.yml /
// latest-mac.yml, verified against electron-updater 6.8.9's
// Provider.getChannelFilePrefix() — are produced by electron-builder's publish
// config, documented in README.md; they were previously pinned by a copy of the
// derivation here, which no production code called.)
import { expect, test } from 'vitest'
import { CHECK_INTERVAL_MS, shouldCheck } from './updater'

test('shouldCheck is true when never checked, after the interval, and false inside it', () => {
  const now = Date.now()
  expect(shouldCheck(null, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS - 1, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS, now, CHECK_INTERVAL_MS)).toBe(true)
  expect(shouldCheck(now - CHECK_INTERVAL_MS + 1, now, CHECK_INTERVAL_MS)).toBe(false)
  expect(shouldCheck(now - 60_000, now, CHECK_INTERVAL_MS)).toBe(false)
})
