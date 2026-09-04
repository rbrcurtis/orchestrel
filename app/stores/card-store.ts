import { makeAutoObservable, runInAction } from 'mobx';
import type { Card, Column, FileRef } from '../../src/shared/ws-protocol';
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

  get cardsByUpdatedDesc(): Card[] {
    return Array.from(this.cards.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getCard(id: number): Card | undefined {
    return this.cards.get(id);
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  /**
   * Merge a server card payload into the store. When the card already exists,
   * copy fields onto the existing observable object instead of replacing it:
   * replacing created a brand-new observable on every live update, which
   * re-announced every field and invalidated every card observer even when
   * nothing they read changed. In-place updates notify only the fields that
   * actually changed.
   */
  private upsertCard(card: Card): void {
    const existing = this.cards.get(card.id);
    if (!existing) {
      this.cards.set(card.id, card);
      return;
    }
    Object.assign(existing, card);
  }

  hydrate(items: unknown[], replace = false, columns?: string[]) {
    if (replace) {
      if (columns && columns.length > 0) {
        // Scoped replace: only drop cards in the columns we're re-hydrating, so
        // lazily-paged columns (e.g. archive) aren't wiped.
        const set = new Set(columns);
        for (const [id, c] of this.cards) {
          if (set.has(c.column)) this.cards.delete(id);
        }
      } else {
        this.cards.clear();
      }
      this.hydrated = true;
    }
    for (const c of items) {
      this.upsertCard(c as Card);
    }
  }

  handleUpdated(card: Card) {
    this.upsertCard(card);
  }

  /** Fetch one page of a column and merge it into the store. */
  async loadPage(column: Column, cursor?: number, limit = 20): Promise<{ nextCursor?: number; total: number }> {
    const res = (await this.ws().emit('page', { column, cursor, limit })) as {
      cards: Card[];
      nextCursor?: number;
      total: number;
    };
    runInAction(() => {
      for (const c of res.cards) this.upsertCard(c);
    });
    return { nextCursor: res.nextCursor, total: res.total };
  }

  /** Server-side search across all cards; merges matches into the store. */
  async search(query: string): Promise<void> {
    const res = (await this.ws().emit('search', { query })) as { cards: Card[]; total: number };
    runInAction(() => {
      for (const c of res.cards) this.upsertCard(c);
    });
  }

  handleDeleted(id: number) {
    this.cards.delete(id);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): Card[] {
    // Exclude lazy-paged columns (archive, backlog): they are not part of the
    // board subscribe and are paged 50 at a time from their routes. Persisting
    // them would restore the entire accumulated set on reload (e.g. every card
    // ever pulled in via "Load more"), defeating pagination — the routes re-page
    // from an empty store instead.
    return Array.from(this.cards.values()).filter((c) => c.column !== 'archive' && c.column !== 'backlog');
  }

  // ── Optimistic mutations ────────────────────────────────────────────────────

  async createCard(data: {
    title: string;
    description?: string | null;
    column?: Column | null;
    projectId?: number | null;
    model?: string;
    provider?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'adaptive';
    summarizeThreshold?: number;
    worktreeBranch?: string | null;
    sourceBranch?: 'HEAD' | 'main' | 'dev' | null;
    pendingInitialFiles?: FileRef[];
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
      pendingInitialFiles: data.pendingInitialFiles,
    })) as Card;
    runInAction(() => this.upsertCard(card));
    return card;
  }

  async createChatCard(data: {
    description: string;
    projectId: number;
    model?: string;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'adaptive';
    summarizeThreshold?: number;
    pendingInitialFiles?: FileRef[];
  }): Promise<Card> {
    let title = 'New chat';

    try {
      const suggested = await this.suggestTitle(data.description);
      if (typeof suggested === 'string' && suggested.trim()) {
        title = suggested.trim();
      }
    } catch {
      // Fall back to default title if suggestion fails.
    }

    const card = (await this.ws().emit('card:create', {
      title,
      description: data.description,
      column: 'running',
      projectId: data.projectId,
      model: data.model,
      thinkingLevel: data.thinkingLevel,
      summarizeThreshold: data.summarizeThreshold,
      archiveOthers: true,
      pendingInitialFiles: data.pendingInitialFiles,
    })) as Card;
    runInAction(() => this.upsertCard(card));
    return card;
  }

  async updateCard(data: {
    id: number;
    title?: string;
    description?: string | null;
    column?: Column;
    position?: number;
    projectId?: number | null;
    provider?: string;
    model?: string;
    summarizeThreshold?: number;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'adaptive';
    worktreeBranch?: string | null;
    sourceBranch?: 'HEAD' | 'main' | 'dev' | null;
  }): Promise<Card> {
    const existing = this.cards.get(data.id);
    // Plain snapshot of previous field values: the optimistic write below
    // mutates the observable in place, so rollback must restore field values
    // rather than re-inserting the (already-mutated) object.
    const backup = existing ? { ...existing } : null;
    if (existing) this.upsertCard({ ...existing, ...data } as Card);

    try {
      const card = (await this.ws().emit('card:update', {
        ...data,
        description: data.description ?? undefined,
      })) as Card;
      runInAction(() => this.upsertCard(card));
      return card;
    } catch (err) {
      runInAction(() => {
        if (backup) this.upsertCard(backup as Card);
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
