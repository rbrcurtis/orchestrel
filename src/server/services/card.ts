import { ILike } from 'typeorm'
import { Card } from '../models/Card'
import type { Column } from '../../shared/ws-protocol'
import { removeWorktree, worktreeExists } from '../worktree'
import { Project } from '../models/Project'

export interface PageResult {
  cards: Card[]
  nextCursor: number | undefined
  total: number
}

const PAGE_SIZE = 20

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

class CardService {
  async listCards(columns?: Column[]): Promise<Card[]> {
    if (columns && columns.length > 0) {
      return Card.find({ where: columns.map(col => ({ column: col })), order: { position: 'ASC' } })
    }
    return Card.find({ order: { position: 'ASC' } })
  }

  async createCard(data: Partial<Card>): Promise<Card> {
    const col = (data.column ?? 'backlog') as Column

    // Compute next position in column
    const maxCard = await Card.findOne({
      where: { column: col },
      order: { position: 'DESC' },
    })
    const position = (maxCard?.position ?? -1) + 1

    // Inherit defaults from project if projectId set
    if (data.projectId) {
      const proj = await Project.findOneBy({ id: data.projectId })
      if (proj) {
        data.model = data.model ?? proj.defaultModel
        data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel
      }
    }

    const now = new Date().toISOString()
    const card = Card.create({
      ...data,
      column: col,
      position,
      createdAt: now,
      updatedAt: now,
    })
    await card.save()

    // Auto-start session when creating directly into running
    if (col === 'running') {
      import('./session').then(({ sessionService }) =>
        sessionService.startSession(card.id, undefined)
      ).catch(err => console.error(`[card:${card.id}] failed to auto-start session:`, err))
    }

    return card
  }

  async updateCard(id: number, data: Partial<Card>): Promise<Card> {
    const card = await Card.findOneByOrFail({ id })
    const movingToRunning = data.column === 'running' && card.column !== 'running'
    const movingToArchive = data.column === 'archive' && card.column !== 'archive'

    // Validate: running requires non-empty title and description
    if (data.column === 'running') {
      const title = data.title ?? card.title
      const desc = data.description !== undefined ? data.description : card.description
      if (!title?.trim()) throw new Error('Title is required for running')
      if (!desc?.trim()) throw new Error('Description is required for running')
    }

    // Worktree removal when archiving
    if (movingToArchive && card.useWorktree && card.worktreePath && card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId })
      if (proj && worktreeExists(card.worktreePath)) {
        try {
          removeWorktree(proj.path, card.worktreePath)
        } catch (err) {
          console.error(`[card:${id}] failed to remove worktree:`, err)
        }
      }
    }

    Object.assign(card, data)
    card.updatedAt = new Date().toISOString()
    await card.save()

    // Auto-start session when moving to running
    if (movingToRunning) {
      import('./session').then(({ sessionService }) =>
        sessionService.startSession(card.id, undefined)
      ).catch(err => console.error(`[card:${id}] failed to auto-start session:`, err))
    }

    return card
  }

  async deleteCard(id: number): Promise<void> {
    const card = await Card.findOneByOrFail({ id })
    await card.remove()
  }

  async searchCards(query: string): Promise<{ cards: Card[]; total: number }> {
    const pattern = `%${query}%`
    const [results, total] = await Card.findAndCount({
      where: [
        { title: ILike(pattern) },
        { description: ILike(pattern) },
      ],
      order: { position: 'ASC' },
    })
    return { cards: results, total }
  }

  async pageCards(column: Column, cursor?: number, limit = PAGE_SIZE): Promise<PageResult> {
    const all = await Card.find({
      where: { column },
      order: { position: 'ASC' },
    })
    const startIdx = cursor !== undefined
      ? all.findIndex(c => c.id === cursor) + 1
      : 0
    const slice = all.slice(startIdx, startIdx + limit)
    const nextCursor = startIdx + limit < all.length
      ? slice[slice.length - 1]?.id
      : undefined
    return { cards: slice, nextCursor, total: all.length }
  }

  async generateTitle(cardId: number): Promise<Card> {
    const card = await Card.findOneByOrFail({ id: cardId })
    if (!card.description) throw new Error('Card has no description to generate title from')
    const title = await ollamaSuggestTitle(card.description)
    card.title = title
    card.updatedAt = new Date().toISOString()
    await card.save()
    return card
  }

  async suggestTitle(description: string): Promise<string> {
    return ollamaSuggestTitle(description)
  }
}

export const cardService = new CardService()
