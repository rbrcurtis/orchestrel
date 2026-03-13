import { makeAutoObservable } from 'mobx'
import type { Card, Column } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'
import { uuid } from '../lib/utils'

let _ws: WsClient | null = null

export function setCardStoreWs(ws: WsClient) {
  _ws = ws
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set')
  return _ws
}

export class CardStore {
  cards = new Map<number, Card>()

  constructor() {
    makeAutoObservable(this)
  }

  // ── Computed views ──────────────────────────────────────────────────────────

  cardsByColumn(col: string): Card[] {
    return Array.from(this.cards.values())
      .filter((c) => c.column === col)
      .sort((a, b) => a.position - b.position)
  }

  getCard(id: number): Card | undefined {
    return this.cards.get(id)
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  hydrate(items: unknown[]) {
    for (const c of items) {
      const card = c as Card
      this.cards.set(card.id, card)
    }
  }

  handleUpdated(card: Card) {
    this.cards.set(card.id, card)
  }

  handleDeleted(id: number) {
    this.cards.delete(id)
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): Card[] {
    return Array.from(this.cards.values())
  }

  // ── Optimistic mutations ────────────────────────────────────────────────────

  async createCard(data: {
    title: string
    description?: string | null
    column?: Column | null
    projectId?: number | null
    model?: 'sonnet' | 'opus'
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
    useWorktree?: boolean
    sourceBranch?: 'main' | 'dev' | null
  }): Promise<Card> {
    const requestId = uuid()
    const card = await ws().mutate<Card>({
      type: 'card:create',
      requestId,
      data: {
        title: data.title,
        description: data.description,
        column: data.column ?? undefined,
        projectId: data.projectId,
        model: data.model,
        thinkingLevel: data.thinkingLevel,
        useWorktree: data.useWorktree,
        sourceBranch: data.sourceBranch,
      },
    })
    this.cards.set(card.id, card)
    return card
  }

  async updateCard(data: {
    id: number
    title?: string
    description?: string | null
    column?: Column
    position?: number
    projectId?: number | null
    model?: 'sonnet' | 'opus'
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
    useWorktree?: boolean
    sourceBranch?: 'main' | 'dev' | null
  }): Promise<Card> {
    const existing = this.cards.get(data.id)
    if (existing) this.cards.set(data.id, { ...existing, ...data } as Card)

    const requestId = uuid()
    try {
      const card = await ws().mutate<Card>({
        type: 'card:update',
        requestId,
        data,
      })
      this.cards.set(card.id, card)
      return card
    } catch (err) {
      if (existing) this.cards.set(data.id, existing)
      throw err
    }
  }

  async deleteCard(id: number): Promise<void> {
    const existing = this.cards.get(id)
    this.cards.delete(id)

    const requestId = uuid()
    try {
      await ws().mutate({ type: 'card:delete', requestId, data: { id } })
    } catch (err) {
      if (existing) this.cards.set(id, existing)
      throw err
    }
  }

  async generateTitle(id: number): Promise<void> {
    const requestId = uuid()
    await ws().mutate({ type: 'card:generateTitle', requestId, data: { id } })
  }

  async suggestTitle(description: string): Promise<string | null> {
    const requestId = uuid()
    const res = await ws().mutate({ type: 'card:suggestTitle', requestId, data: { description } })
    return typeof res === 'string' ? res : null
  }
}
