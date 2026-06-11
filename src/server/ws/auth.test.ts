import type { IncomingMessage } from 'http'
import { describe, expect, it } from 'vitest'
import { validateCfAccess } from './auth'

function requestForHost(host: string): IncomingMessage {
  return { headers: { host } } as IncomingMessage
}

describe('validateCfAccess', () => {
  it('bypasses Cloudflare Access for 10.x VPN hosts', async () => {
    await expect(validateCfAccess(requestForHost('10.88.0.1:6194'))).resolves.toEqual({
      valid: true,
      isLocal: true,
    })
  })
})
