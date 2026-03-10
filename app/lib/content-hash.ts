/**
 * Deterministic content hash for conversation row dedup.
 * Uses SHA-256 via Web Crypto (available in all modern browsers + Node 18+).
 * Falls back to simple string hash if crypto.subtle unavailable.
 */
export async function contentHash(type: string, message: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify({ type, message })
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(payload)
    const hash = await crypto.subtle.digest('SHA-256', buf)
    const arr = new Uint8Array(hash)
    return Array.from(arr.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback: simple djb2 hash
  let h = 5381
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/**
 * Synchronous content hash using djb2. Use when async is inconvenient
 * (e.g., inside MobX actions that must be synchronous).
 */
export function contentHashSync(type: string, message: Record<string, unknown>): string {
  const payload = JSON.stringify({ type, message })
  let h = 5381
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}
