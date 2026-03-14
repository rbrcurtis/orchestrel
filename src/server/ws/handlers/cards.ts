import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { db } from '../../db/index'
import { cards, projects } from '../../db/schema'
import { eq } from 'drizzle-orm'
import {
  removeWorktree,
  worktreeExists,
} from '../../worktree'
import { beginSession } from '../../agents/begin-session'

export async function handleCardCreate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:create' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const input = msg.data
    const col = input.column ?? 'backlog'

    // Validate: running requires non-empty title and description
    if (col === 'running') {
      if (!input.title?.trim()) throw new Error('Title is required for running')
      if (!input.description?.trim()) throw new Error('Description is required for running')
    }

    const extra: Record<string, unknown> = {}

    // Fetch project for defaults and worktree setup
    if (input.projectId) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, input.projectId)).get()
        if (proj) {
          extra.model = input.model ?? proj.defaultModel
          extra.thinkingLevel = input.thinkingLevel ?? proj.defaultThinkingLevel

          // Worktree setup is handled by beginSession → ensureWorktree (async, non-blocking)
        }
      } catch (err) {
        console.error('Failed to fetch project for card:', err)
      }
    }

    const card = mutator.createCard({ ...input, ...extra, column: col })
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })

    // Auto-start session when creating directly into running
    if (col === 'running') {
      beginSession(card.id, undefined, ws, connections, mutator).catch((err) => {
        console.error(`[session:${card.id}] auto-start on create failed:`, err)
      })
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleCardUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:update' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const { id, ...data } = msg.data
    const existing = db.select().from(cards).where(eq(cards.id, id)).get()
    if (!existing) throw new Error(`Card ${id} not found`)

    const movingToRunning = data.column === 'running' && existing.column !== 'running'

    // Validate: running requires non-empty title and description
    if (data.column === 'running') {
      const title = data.title ?? existing.title
      const desc = data.description !== undefined ? data.description : existing.description
      if (!title?.trim()) throw new Error('Title is required for running')
      if (!desc?.trim()) throw new Error('Description is required for running')
    }

    // Worktree setup is handled by beginSession → ensureWorktree (async, non-blocking)
    const updates: Record<string, unknown> = { ...data }

    // Worktree removal when moving to archive
    if (
      data.column === 'archive' &&
      existing.column !== 'archive' &&
      existing.useWorktree &&
      existing.worktreePath &&
      existing.projectId
    ) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, existing.projectId)).get()
        if (proj && worktreeExists(existing.worktreePath)) {
          try {
            removeWorktree(proj.path, existing.worktreePath)
          } catch (err) {
            console.error(`[card:${id}] failed to remove worktree:`, err)
          }
        }
      } catch (err) {
        console.error(`[card:${id}] failed to clean up worktree:`, err)
      }
    }

    const card = mutator.updateCard(id, updates)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })

    // Auto-start session when moving to running
    if (movingToRunning) {
      beginSession(card.id, undefined, ws, connections, mutator).catch((err) => {
        console.error(`[session:${id}] auto-start failed:`, err)
        connections.send(ws, {
          type: 'agent:status',
          data: { cardId: id, active: false, status: 'errored', sessionId: null, promptsSent: 0, turnsCompleted: 0 },
        })
      })
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export function handleCardDelete(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:delete' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): void {
  const { requestId } = msg
  try {
    mutator.deleteCard(msg.data.id)
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

async function ollamaSuggestTitle(description: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b',
      stream: false,
      prompt: `Generate a kanban card title of 3 words or fewer based on this description. Return only the title text, no quotes, no prefix.\n\nDescription: ${description}`,
    }),
  })
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`)
  const data = await res.json() as { response: string }
  return data.response.trim()
}

export async function handleCardGenerateTitle(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:generateTitle' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const card = db.select().from(cards).where(eq(cards.id, msg.data.id)).get()
    if (!card) throw new Error(`Card ${msg.data.id} not found`)
    if (!card.description) throw new Error('Card has no description to generate title from')

    const title = await ollamaSuggestTitle(card.description)
    const updated = mutator.updateCard(card.id, { title })
    connections.send(ws, { type: 'mutation:ok', requestId, data: updated })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleCardSuggestTitle(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:suggestTitle' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId } = msg
  try {
    const title = await ollamaSuggestTitle(msg.data.description)
    connections.send(ws, { type: 'mutation:ok', requestId, data: title })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
