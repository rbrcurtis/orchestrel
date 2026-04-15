import { makeAutoObservable, runInAction } from 'mobx';
import type { Card, Column } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';

export class CardStore {
  cards = new Map<number, Card>();
  hydrated = false;
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, '_ws'>(this, { _ws: false });
  }

  setWs(ws: WsClient) { this._ws = ws; }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
  }

  // ── Computed views ──────────────────────────────────────────────────────────

  cardsByColumn(col: string): Card[] {
    const items = Array.from(this.cards.values()).filter((c) => c.column === col);
    if (col === 'archive') return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items.sort((a, b) => a.position - b.position);
  }

  get cardsByCreatedDesc(): Card[] {
    return Array.from(this.cards.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCard(id: number): Card | undefined {
    return this.cards.get(id);
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  hydrate(items: unknown[], replace = false) {
    if (replace) {
      this.cards.clear();
      this.hydrated = true;
    }
    for (const c of items) {
      const card = c as Card;
      this.cards.set(card.id, card);
    }
  }

  handleUpdated(card: Card) {
    this.cards.set(card.id, card);
  }

  handleDeleted(id: number) {
    this.cards.delete(id);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): Card[] {
    return Array.from(this.cards.values());
  }

  // ── Optimistic mutations ────────────────────────────────────────────────────

  async createCard(data: {
    title: string;
    description?: string | null;
    column?: Column | null;
    projectId?: number | null;
    model?: string;
    provider?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    summarizeThreshold?: number;
    worktreeBranch?: string | null;
    sourceBranch?: 'main' | 'dev' | null;
  }): Promise<Card> {
    const card = (await this.ws().emit('card:create', {
      title: data.title,
      description: data.description ?? undefined,
      column: data.column ?? undefined,
      projectId: data.projectId,
      model: data.model,
      provider: data.provider,
      thinkingLevel: data.thinkingLevel,
      summarizeThreshold: data.summarizeThreshold,
      worktreeBranch: data.worktreeBranch,
      sourceBranch: data.sourceBranch,
    })) as Card;
    runInAction(() => this.cards.set(card.id, card));
    return card;
  }

  async createChatCard(data: {
    description: string;
    projectId: number;
    model?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    summarizeThreshold?: number;
  }): Promise<Card> {
    const card = (await this.ws().emit('card:create', {
      title: 'New chat',
      description: data.description,
      column: 'running',
      projectId: data.projectId,
      model: data.model,
      thinkingLevel: data.thinkingLevel,
      summarizeThreshold: data.summarizeThreshold,
      archiveOthers: true,
    })) as Card;
    runInAction(() => this.cards.set(card.id, card));
    return card;
  }

  async updateCard(data: {
    id: number;
    title?: string;
    description?: string | null;
    column?: Column;
    position?: number;
    projectId?: number | null;
    model?: string;
    summarizeThreshold?: number;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    worktreeBranch?: string | null;
    sourceBranch?: 'main' | 'dev' | null;
  }): Promise<Card> {
    const existing = this.cards.get(data.id);
    if (existing) this.cards.set(data.id, { ...existing, ...data } as Card);

    try {
      const card = (await this.ws().emit('card:update', {
        ...data,
        description: data.description ?? undefined,
      })) as Card;
      runInAction(() => this.cards.set(card.id, card));
      return card;
    } catch (err) {
      runInAction(() => {
        if (existing) this.cards.set(data.id, existing);
      });
      throw err;
    }
  }

  async deleteCard(id: number): Promise<void> {
    const existing = this.cards.get(id);
    this.cards.delete(id);

    try {
      await this.ws().emit('card:delete', { id });
    } catch (err) {
      runInAction(() => {
        if (existing) this.cards.set(id, existing);
      });
      throw err;
    }
  }

  async generateTitle(id: number): Promise<void> {
    await this.ws().emit('card:generateTitle', { id });
  }

  async suggestTitle(description: string): Promise<string | null> {
    const res = await this.ws().emit('card:suggestTitle', { description });
    return typeof res === 'string' ? res : null;
  }
}
