import type { WebSocket } from 'ws'
import type { ClientMessage, ClaudeMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync, statSync } from 'fs'

const SESSIONS_DIR = join(process.cwd(), 'data', 'sessions')

function parseSessionFile(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null)
}

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { sessionId, cardId } = msg.data

  let messages: ClaudeMessage[] = []

  const localPath = join(SESSIONS_DIR, `${sessionId}.jsonl`)
  if (existsSync(localPath)) {
    try {
      const content = await readFile(localPath, 'utf-8')
      const parsed = parseSessionFile(content)
      const filtered = parsed.filter(
        m => m.type === 'assistant' || m.type === 'user' || m.type === 'result' || m.type === 'system'
      )

      // Inject file mtime as fallback timestamp on the last result message (for old sessions without ts)
      const lastResult = [...filtered].reverse().find(m => m.type === 'result' && !m.ts)
      if (lastResult) {
        const mtime = statSync(localPath).mtime.toISOString()
        Object.assign(lastResult, { _mtime: mtime })
      }

      // Cast to ClaudeMessage — same shape, validated by JSONL format
      messages = filtered as unknown as ClaudeMessage[]
    } catch (err) {
      console.error(`Failed to load session ${sessionId}:`, err)
    }
  }

  connections.send(ws, {
    type: 'session:history',
    data: { cardId, messages },
  })

  // Send mutation:ok so client's mutate() resolves
  connections.send(ws, {
    type: 'mutation:ok',
    data: { requestId: sessionId, result: null },
  })
}
