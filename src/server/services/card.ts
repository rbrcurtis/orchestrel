import { ILike, IsNull } from 'typeorm';
import path from 'node:path';
import { Card } from '../models/Card';
import type { Column } from '../../shared/ws-protocol';
import { Project } from '../models/Project';
import { contextWindowFor, defaultProviderFor } from '../config/capabilities';
import { slugify } from '../../shared/worktree';

export interface PageResult {
  cards: Card[];
  nextCursor: number | undefined;
  total: number;
}

const PAGE_SIZE = 20;

function textFromContent(content: unknown): string | null {
  let text = '';
  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim();
  }
  return text || null;
}

function firstUserMessage(history: unknown[]): string | null {
  let found: string | null = null;
  for (const item of history) {
    if (typeof item !== 'object' || item === null) continue;
    const message = (item as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    found = textFromContent(record.content);
    if (found) break;
  }
  return found;
}

function fallbackTitle(description: string): string {
  const words = description
    .replace(/[`#>*_~()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 3);
  return words.join(' ') || 'Imported session';
}

async function ollamaSuggestTitle(description: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2:latest',
      stream: false,
      options: { num_predict: 12, temperature: 0, num_ctx: 512 },
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
    let providerID: string | undefined;
    let nodeName = 'local';
    if (data.projectId) {
      const proj = await Project.findOneBy({ id: data.projectId });
      if (proj) {
        nodeName = proj.nodeName ?? 'local';
        providerID = proj.providerID ?? undefined;
        data.model = data.model ?? proj.defaultModel;
        data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel;
        data.sourceBranch = data.sourceBranch ?? proj.defaultBranch;
        // Mirror the UI's card-create behavior: when the project defaults to
        // worktrees, derive the branch from the title. Explicit null (user
        // unchecked "use worktree" in the UI) is respected — only fill in the
        // default when the caller didn't specify.
        if (data.worktreeBranch === undefined && proj.isGitRepo && proj.defaultWorktree) {
          data.worktreeBranch = slugify(data.title ?? '') || null;
        }
      }
    }
    providerID = providerID ?? defaultProviderFor(nodeName) ?? 'anthropic';
    data.provider = data.provider ?? providerID;
    data.nodeName = nodeName;
    data.summarizeThreshold = data.summarizeThreshold ?? 0;

    // Best-effort initial context window from the node's advertised capabilities.
    // May be undefined if the node isn't connected yet, leaving the 200k schema
    // default; that's fine — it's a cache, self-healed from live caps at session
    // start (see windowForCard / card-sessions startSession). Runtime uses derive
    // the window live regardless of this value.
    const cw = contextWindowFor(nodeName, providerID, data.model ?? 'sonnet');
    if (cw) data.contextWindow = cw;

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
      await this.archiveOtherActiveCardsForProject(card.id, card.projectId);
    }

    return card;
  }

  async updateCard(id: number, data: Partial<Card>): Promise<Card> {
    const card = await Card.findOneByOrFail({ id });

    // Update contextWindow when provider/model changes
    if (data.provider || data.model) {
      const providerID = data.provider ?? card.provider ?? 'anthropic';
      const cw = contextWindowFor(card.nodeName, providerID, data.model ?? card.model);
      if (cw) data.contextWindow = cw;
    }

    // Kill session when card leaves running/review — but NOT when archiving.
    // Archiving while a session is running lets the agent finish (e.g. a final
    // fire-and-forget command); the session_exit handler keeps the card archived.
    const liveColumns = new Set<string>(['running', 'review']);
    if (data.column && data.column !== 'archive' && liveColumns.has(card.column) && !liveColumns.has(data.column)) {
      const initState = await import('../init-state');
      const client = initState.getClientByNode(card.nodeName);
      if (card.sessionId && client?.isActive(card.sessionId)) {
        console.log(`[session:${id}] stopping: card moving ${card.column} → ${data.column}`);
        client.cancel(card.sessionId);
      }
    }

    Object.assign(card, data);
    card.updatedAt = new Date().toISOString();
    await card.save();

    return card;
  }

  async deleteCard(id: number): Promise<void> {
    const card = await Card.findOneByOrFail({ id });
    const initState = await import('../init-state');
    const client = initState.getClientByNode(card.nodeName);
    if (card.sessionId && client?.isActive(card.sessionId)) {
      console.log(`[session:${id}] stopping: card deleted`);
      client.cancel(card.sessionId);
    }
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

  async pageCards(
    column: Column,
    cursor?: number,
    limit = PAGE_SIZE,
    visible?: number[] | 'all',
  ): Promise<PageResult> {
    // Order matches the client's column sort so paged slices stay contiguous with
    // what the UI renders: archive is newest-updated first, active columns (backlog)
    // are position ASC. id is a tiebreaker so the total order is stable across calls
    // — without it, cards sharing the sort key (e.g. bulk-archived, equal position)
    // can reorder between queries, making the id cursor land at a different index
    // and skip/duplicate a page.
    const order =
      column === 'archive'
        ? { updatedAt: 'DESC' as const, id: 'DESC' as const }
        : { position: 'ASC' as const, id: 'ASC' as const };
    const found = await Card.find({
      where: { column },
      order,
    });
    // Filter by user visibility BEFORE slicing so page sizes stay correct.
    const all =
      !visible || visible === 'all'
        ? found
        : found.filter((c) => c.projectId != null && visible.includes(c.projectId));
    const startIdx = cursor !== undefined ? all.findIndex((c) => c.id === cursor) + 1 : 0;
    const slice = all.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < all.length ? slice[slice.length - 1]?.id : undefined;
    return { cards: slice, nextCursor, total: all.length };
  }

  async importSession(opts: { sessionId: string; path: string; nodeName: string }): Promise<Card> {
    const sessionId = opts.sessionId.trim();
    if (!sessionId) throw new Error('Session ID is required');
    if (!opts.path) throw new Error('Project path is required');
    if (!path.isAbsolute(opts.path)) throw new Error('Import path must be absolute');
    if (!opts.nodeName.trim()) throw new Error('Node name is required');

    let project = await Project.findOneBy({ path: opts.path, nodeName: opts.nodeName });
    const initState = await import('../init-state');
    const client = initState.getClientByNode(opts.nodeName);
    if (!client || !client.isConnected()) throw new Error(`No connected orcd client for node ${opts.nodeName}`);

    if (!project) {
      const candidates = await Project.findBy({ nodeName: opts.nodeName });
      for (const candidate of candidates) {
        const [supplied, configured] = await Promise.all([
          client.pathValidate(opts.path),
          client.pathValidate(candidate.path),
        ]);
        if (supplied.isGitRepo && configured.isGitRepo && supplied.gitCommonDir && supplied.gitCommonDir === configured.gitCommonDir) {
          project = candidate;
          break;
        }
      }
    }
    if (!project) throw new Error(`No project configured for path: ${opts.path}`);

    const existing = await Card.findOneBy({ sessionId });
    if (existing) throw new Error(`Session ${sessionId} is already associated with a card`);

    const history = await client.getHistory(sessionId, opts.path);
    if (history.length === 0) throw new Error(`No history found for session ${sessionId}`);
    const description = firstUserMessage(history);
    if (!description) throw new Error(`Session ${sessionId} has no substantive user message`);

    let title: string;
    try {
      title = await ollamaSuggestTitle(description);
    } catch (err) {
      console.warn(`[card:import:${sessionId}] title generation failed:`, err);
      title = '';
    }
    title = title.trim() || fallbackTitle(description);

    const duplicate = await Card.findOneBy({ sessionId });
    if (duplicate) {
      console.error(`[card:import:${sessionId}] session is already associated with card ${duplicate.id}`);
      throw new Error(`Session ${sessionId} is already associated with a card`);
    }

    try {
      const card = await this.createCard({
        title,
        description,
        projectId: project.id,
        sessionId,
        sessionCwd: opts.path === project.path ? null : opts.path,
        column: 'review',
        sandbox: project.defaultSandbox,
        // Imported sessions already ran wherever sessionCwd points — never
        // derive a worktree branch from the project default.
        worktreeBranch: null,
      });
      console.log(`[card:import:${sessionId}] created card ${card.id}`);
      return card;
    } catch (err) {
      console.error(`[card:import:${sessionId}] create failed:`, err);
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed: cards.session_id')) {
        throw new Error(`Session ${sessionId} is already associated with a card`);
      }
      throw err;
    }
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

  async archiveOtherActiveCardsForProject(excludeId?: number, projectId?: number | null): Promise<void> {
    const activeColumns: Column[] = ['backlog', 'ready', 'running', 'review'];
    const projectFilter = projectId ?? IsNull();
    const toArchive = await Card.find({
      where: activeColumns.map((column) => ({ column, projectId: projectFilter })),
    });

    const filtered = excludeId ? toArchive.filter((c) => c.id !== excludeId) : toArchive;
    if (filtered.length === 0) {
      console.log(
        `[card:archiveProject] nothing to archive (projectId=${projectId ?? 'none'}, excludeId=${excludeId ?? 'none'})`,
      );
      return;
    }

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
