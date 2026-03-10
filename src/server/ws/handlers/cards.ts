import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { db } from '../../db/index'
import { cards, projects } from '../../db/schema'
import { eq } from 'drizzle-orm'
import {
  createWorktree,
  removeWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../../worktree'

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

    const extra: Record<string, unknown> = {}

    // Fetch project for defaults and worktree setup
    if (input.projectId) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, input.projectId)).get()
        if (proj) {
          extra.model = input.model ?? proj.defaultModel
          extra.thinkingLevel = input.thinkingLevel ?? proj.defaultThinkingLevel

          // Set up working directory when creating directly into in_progress
          if (col === 'in_progress') {
            try {
              if (!input.useWorktree) {
                extra.worktreePath = proj.path
              } else {
                const slug = slugify(input.title)
                const wtPath = `${proj.path}/.worktrees/${slug}`
                const branch = slug
                const source = input.sourceBranch ?? proj.defaultBranch ?? undefined

                if (!worktreeExists(wtPath)) {
                  createWorktree(proj.path, wtPath, branch, source ?? undefined)
                  if (proj.setupCommands) {
                    runSetupCommands(wtPath, proj.setupCommands)
                  }
                }

                extra.worktreePath = wtPath
                extra.worktreeBranch = branch
              }
            } catch (err) {
              console.error('Failed to set up working directory for new card:', err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch project for card:', err)
      }
    }

    const card = mutator.createCard({ ...input, ...extra, column: col })
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
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
    const card = mutator.updateCard(id, data)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleCardMove(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:move' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const input = msg.data
    const existing = db.select().from(cards).where(eq(cards.id, input.id)).get()
    if (!existing) throw new Error(`Card ${input.id} not found`)

    const columnChanged = existing.column !== input.column

    const updates: Record<string, unknown> = {}

    // Worktree / working directory setup when moving to in_progress
    if (columnChanged && input.column === 'in_progress' && existing.projectId) {
      try {
        const proj = db.select().from(projects).where(eq(projects.id, existing.projectId)).get()
        if (proj) {
          if (!existing.useWorktree) {
            updates.worktreePath = proj.path
          } else {
            const slug = existing.worktreeBranch || slugify(existing.title)
            const wtPath = existing.worktreePath || `${proj.path}/.worktrees/${slug}`
            const branch = slug
            const source = existing.sourceBranch ?? proj.defaultBranch ?? undefined

            if (!worktreeExists(wtPath)) {
              createWorktree(proj.path, wtPath, branch, source ?? undefined)
              if (proj.setupCommands) {
                runSetupCommands(wtPath, proj.setupCommands)
              }
            }

            updates.worktreePath = wtPath
            updates.worktreeBranch = branch
          }
        }
      } catch (err) {
        console.error(`Failed to set up working directory for card ${existing.id}:`, err)
      }
    }

    // Worktree removal when moving to archive (preserve path/branch/session fields)
    if (
      columnChanged &&
      input.column === 'archive' &&
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
            console.error(`Failed to remove worktree for card ${existing.id}:`, err)
          }
        }
      } catch (err) {
        console.error(`Failed to clean up worktree for card ${existing.id}:`, err)
      }
      // Do NOT null worktreePath, worktreeBranch, or sessionId — needed for resumption
    }

    // Merge worktree field updates into the move to avoid an intermediate broadcast
    // (a separate updateCard would broadcast the old column, causing a visible flash)
    const position = input.position ?? 0
    const card = mutator.moveCard(input.id, input.column, position, Object.keys(updates).length > 0 ? updates : undefined)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
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
