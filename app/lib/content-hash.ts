/**
 * Synchronous content hash using djb2 for conversation row dedup.
 * Normalizes user message content (string vs content-block array)
 * so optimistic sends match server echoes.
 */
export function contentHashSync(type: string, message: Record<string, unknown>): string {
  let payload: string
  if (type === 'user') {
    // Normalize: extract plain text regardless of string vs content-block format
    const content = message.content
    let text: string
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = (content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('')
    } else {
      text = JSON.stringify(content)
    }
    payload = JSON.stringify({ type: 'user', text })
  } else {
    payload = JSON.stringify({ type, message })
  }
  let h = 5381
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}
