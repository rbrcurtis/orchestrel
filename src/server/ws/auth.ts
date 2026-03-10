import type { IncomingMessage } from 'http'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const CF_TEAM_DOMAIN = 'rbrcurtis' // <team>.cloudflareaccess.com
const CERTS_URL = `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`

// jose caches JWK set and handles rotation automatically
const jwks = createRemoteJWKSet(new URL(CERTS_URL))

/**
 * Validate Cloudflare Access JWT from the CF_Authorization cookie.
 * Uses jose for full cryptographic signature verification.
 * In dev mode, skip validation.
 */
export async function validateCfAccess(req: IncomingMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'development') return true

  const cookie = req.headers.cookie ?? ''
  const match = cookie.match(/CF_Authorization=([^;]+)/)
  if (!match) return false

  try {
    await jwtVerify(match[1], jwks, {
      issuer: `https://${CF_TEAM_DOMAIN}.cloudflareaccess.com`,
    })
    return true
  } catch {
    return false
  }
}
