import type { WebSocket } from 'ws'
import type { ClientMessage, ClaudeMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { db } from '../../db/index'
import { cards } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { getSDKSessionPath } from '../../claude/session-path'
import { sessionManager } from '../../claude/manager'

const LEGACY_SESSIONS_DIR = join(process.cwd(), 'data', 'sessions')
const ACTIVE_THRESHOLD = 5 * 60_000 // 5 minutes

function injectTurnDividers(parsed: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  let lastAssistant: Record<string, unknown> | null = null
  let addedInit = false

  // Get model from first assistant message for the session-started header
  const firstAssistant = parsed.find(m => m.type === 'assistant')
  const initModel = (firstAssistant?.message as { model?: string } | undefined)?.model ?? null

  for (const msg of parsed) {
    // Inject a synthetic system init before the first user message
    if (msg.type === 'user' && !addedInit && initModel) {
      result.push({ type: 'system', message: { subtype: 'init', model: initModel } })
      addedInit = true
    }

    if (msg.type === 'assistant') {
      lastAssistant = msg
      result.push(msg)
    } else if (msg.type === 'last-prompt') {
      // Synthesize a result divider using data from the preceding assistant message
      if (lastAssistant) {
        const inner = lastAssistant.message as { model?: string; usage?: Record<string, number> } | undefined
        const model = inner?.model
        const usage = inner?.usage
        const synthetic: Record<string, unknown> = {
          type: 'result',
          subtype: 'success',
          ts: (lastAssistant.timestamp as string | undefined) ?? new Date().toISOString(),
        }
        if (model && usage) {
          synthetic.modelUsage = {
            [model]: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
              costUSD: 0,
            },
          }
        }
        result.push(synthetic)
        lastAssistant = null
      }
      // Don't push the last-prompt itself — it's not displayed
    } else {
      result.push(msg)
    }
  }

  return result
}

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

/** Find the JSONL file for a session — SDK path first, then legacy fallback */
function findSessionFile(sessionId: string, worktreePath: string | null): string | null {
  // Try SDK native path
  if (worktreePath) {
    const sdkPath = getSDKSessionPath(worktreePath, sessionId)
    if (existsSync(sdkPath)) return sdkPath
  }

  // Fall back to legacy data/sessions/ directory
  const legacyPath = join(LEGACY_SESSIONS_DIR, `${sessionId}.jsonl`)
  if (existsSync(legacyPath)) return legacyPath

  return null
}

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { sessionId, cardId } } = msg

  // Look up card to get worktreePath for SDK session file resolution
  const card = db.select({ worktreePath: cards.worktreePath }).from(cards).where(eq(cards.id, cardId)).get()
  const filePath = findSessionFile(sessionId, card?.worktreePath ?? null)

  let messages: ClaudeMessage[] = []

  if (filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = parseSessionFile(content)
      const withDividers = injectTurnDividers(parsed)
      const filtered = withDividers.filter(
        m => m.type === 'assistant' || m.type === 'user' || m.type === 'result' || m.type === 'system'
      )

      // Inject file mtime as fallback timestamp on the last result message (for old sessions without ts)
      const lastResult = [...filtered].reverse().find(m => m.type === 'result' && !m.ts)
      if (lastResult) {
        const mtime = statSync(filePath).mtime.toISOString()
        Object.assign(lastResult, { ts: mtime })
      }

      // Wrap raw SDK messages in ClaudeMessage shape ({ type, message: {...} })
      messages = filtered.map(m => {
        if (m.message && typeof m.message === 'object') {
          return m as unknown as ClaudeMessage
        }
        return {
          type: m.type as ClaudeMessage['type'],
          message: m,
          ...(m.isSidechain !== undefined && { isSidechain: m.isSidechain as boolean }),
          ...(m.ts !== undefined && { ts: m.ts as string }),
        } as ClaudeMessage
      })
    } catch (err) {
      console.error(`Failed to load session ${sessionId}:`, err)
    }

    // If file was recently modified and no Dispatcher-managed session is running,
    // start tailing for live updates from external CLI
    if (!sessionManager.get(cardId)) {
      try {
        const mtime = statSync(filePath).mtimeMs
        if (Date.now() - mtime < ACTIVE_THRESHOLD) {
          const tailer = sessionManager.startTailing(cardId, filePath)

          // Forward new messages from tailer to WS client
          tailer.on('message', (rawMsg: Record<string, unknown>) => {
            const type = rawMsg.type as string
            if (type !== 'assistant' && type !== 'user' && type !== 'result' && type !== 'system') return

            const wrapped: ClaudeMessage = rawMsg.message && typeof rawMsg.message === 'object'
              ? rawMsg as unknown as ClaudeMessage
              : {
                  type: type as ClaudeMessage['type'],
                  message: rawMsg,
                  ...(rawMsg.isSidechain !== undefined && { isSidechain: rawMsg.isSidechain as boolean }),
                  ...(rawMsg.ts !== undefined && { ts: rawMsg.ts as string }),
                } as ClaudeMessage

            connections.send(ws, {
              type: 'claude:message',
              cardId,
              data: wrapped,
            })
          })

          // Send active status so client shows live state
          connections.send(ws, {
            type: 'claude:status',
            data: {
              cardId,
              active: true,
              status: 'running',
              sessionId,
              promptsSent: 0,
              turnsCompleted: 0,
            },
          })

          // When tailer goes stale, notify client session is done
          tailer.on('stale', () => {
            connections.send(ws, {
              type: 'claude:status',
              data: {
                cardId,
                active: false,
                status: 'completed',
                sessionId,
                promptsSent: 0,
                turnsCompleted: 0,
              },
            })
          })
        }
      } catch { /* ignore mtime errors */ }
    }
  }

  connections.send(ws, {
    type: 'session:history',
    requestId,
    cardId,
    messages,
  })

  connections.send(ws, {
    type: 'mutation:ok',
    requestId,
  })
}
