import { ILike } from 'typeorm';
import { Card } from '../models/Card';
import type { Column } from '../../shared/ws-protocol';
import { Project } from '../models/Project';
import { getDefaultProviderID, getModelConfig } from '../config/providers';

export interface PageResult {
  cards: Card[];
  nextCursor: number | undefined;
  total: number;
}

const PAGE_SIZE = 20;

async function ollamaSuggestTitle(description: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b',
      stream: false,
      prompt: `Generate a kanban card title of 3 words or fewer based on this description. Return only the title text, no quotes, no prefix.\n\nDescription: ${description}`,
    }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { response: string };
  return data.response.trim();
}

class CardService {
  async listCards(columns?: Column[]): Promise<Card[]> {
    const cards =
      columns && columns.length > 0
        ? await Card.find({ where: columns.map((col) => ({ column: col })) })
        : await Card.find();
    return cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createCard(data: Partial<Card> & { archiveOthers?: boolean }): Promise<Card> {
    const col = (data.column ?? 'backlog') as Column;

    // Compute next position in column
    const maxCard = await Card.findOne({
      where: { column: col },
      order: { position: 'DESC' },
    });
    const position = (maxCard?.position ?? -1) + 1;

    // Inherit defaults from project if projectId set
    let providerID = getDefaultProviderID();
    if (data.projectId) {
      const proj = await Project.findOneBy({ id: data.projectId });
      if (proj) {
        providerID = proj.providerID ?? getDefaultProviderID();
        data.model = data.model ?? proj.defaultModel;
        data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel;
        data.useWorktree = data.useWorktree ?? proj.defaultWorktree;
      }
    }

    // Set contextWindow from provider config
    const modelCfg = getModelConfig(providerID, data.model ?? 'sonnet');
    if (modelCfg) data.contextWindow = modelCfg.contextWindow;

    const now = new Date().toISOString();
    const card = Card.create({
      ...data,
      column: col,
      position,
      createdAt: now,
      updatedAt: now,
    });
    await card.save();

    if (data.archiveOthers) {
      await this.archiveAllNonArchived(card.id);
    }

    return card;
  }

  async updateCard(id: number, data: Partial<Card>): Promise<Card> {
    const card = await Card.findOneByOrFail({ id });

    // Update contextWindow when model changes
    if (data.model) {
      const proj = card.projectId ? await Project.findOneBy({ id: card.projectId }) : null;
      const providerID = proj?.providerID ?? getDefaultProviderID();
      const modelCfg = getModelConfig(providerID, data.model);
      if (modelCfg) data.contextWindow = modelCfg.contextWindow;
    }

    // Kill session when card leaves running/review
    const liveColumns = new Set<string>(['running', 'review']);
    if (data.column && liveColumns.has(card.column) && !liveColumns.has(data.column)) {
      const { sessionManager } = await import('../agents/manager');
      const session = sessionManager.get(id);
      if (session) {
        console.log(`[session:${id}] killing: card moving ${card.column} → ${data.column}`);
        sessionManager.requestStop(id);
      }
    }

    Object.assign(card, data);
    card.updatedAt = new Date().toISOString();
    await card.save();

    return card;
  }

  async deleteCard(id: number): Promise<void> {
    const { sessionManager } = await import('../agents/manager');
    const session = sessionManager.get(id);
    if (session) {
      console.log(`[session:${id}] killing: card deleted`);
      sessionManager.requestStop(id);
    }
    const card = await Card.findOneByOrFail({ id });
    await card.remove();
  }

  async searchCards(query: string): Promise<{ cards: Card[]; total: number }> {
    const pattern = `%${query}%`;
    const [results, total] = await Card.findAndCount({
      where: [{ title: ILike(pattern) }, { description: ILike(pattern) }],
      order: { updatedAt: 'DESC' },
    });
    return { cards: results, total };
  }

  async pageCards(column: Column, cursor?: number, limit = PAGE_SIZE): Promise<PageResult> {
    const order = { updatedAt: 'DESC' as const };
    const all = await Card.find({
      where: { column },
      order,
    });
    const startIdx = cursor !== undefined ? all.findIndex((c) => c.id === cursor) + 1 : 0;
    const slice = all.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < all.length ? slice[slice.length - 1]?.id : undefined;
    return { cards: slice, nextCursor, total: all.length };
  }

  async generateTitle(cardId: number): Promise<Card> {
    const card = await Card.findOneByOrFail({ id: cardId });
    if (!card.description) throw new Error('Card has no description to generate title from');
    const title = await ollamaSuggestTitle(card.description);
    card.title = title;
    card.updatedAt = new Date().toISOString();
    await card.save();
    return card;
  }

  async archiveAllNonArchived(excludeId?: number): Promise<void> {
    const toArchive = await Card.find({
      where: [
        { column: 'backlog' as Column },
        { column: 'ready' as Column },
        { column: 'running' as Column },
        { column: 'review' as Column },
      ],
    });

    const filtered = excludeId ? toArchive.filter((c) => c.id !== excludeId) : toArchive;
    if (filtered.length === 0) return;

    const now = new Date().toISOString();
    for (const c of filtered) {
      c.column = 'archive' as Column;
      c.updatedAt = now;
    }
    await Card.save(filtered);
  }

  async suggestTitle(description: string): Promise<string> {
    return ollamaSuggestTitle(description);
  }
}

export const cardService = new CardService();
