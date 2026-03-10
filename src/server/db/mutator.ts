import { eq, sql, asc, inArray } from 'drizzle-orm'
import { db } from './index'
import { cards, projects, NEON_COLORS } from './schema'
import type { ConnectionManager } from '../ws/connections'
import type { Card, Project, Column } from '../../shared/ws-protocol'

export class DbMutator {
  constructor(private connMgr: ConnectionManager) {}

  // --- Cards ---

  listCards(columns?: Column[]): Card[] {
    if (columns && columns.length > 0) {
      return db.select().from(cards).where(inArray(cards.column, columns)).orderBy(asc(cards.position)).all()
    }
    return db.select().from(cards).orderBy(asc(cards.position)).all()
  }

  createCard(data: Record<string, unknown>): Card {
    const col = (data.column as string) || 'backlog'
    const maxPos = db.select({ max: sql<number>`max(position)` })
      .from(cards).where(eq(cards.column, col)).get()
    const position = (maxPos?.max ?? -1) + 1

    const created = db.insert(cards).values({
      ...data,
      position,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).returning().get()

    this.connMgr.broadcast({ type: 'card:updated', data: created as Card }, col)
    return created as Card
  }

  updateCard(id: number, data: Record<string, unknown>): Card {
    const updated = db.update(cards)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ ...data, updatedAt: new Date().toISOString() } as any)
      .where(eq(cards.id, id))
      .returning().get()
    this.connMgr.broadcast(
      { type: 'card:updated', data: updated as Card },
      (updated as Card).column,
    )
    return updated as Card
  }

  moveCard(id: number, column: Column, position: number, extraData?: Record<string, unknown>): Card {
    const prev = db.select().from(cards).where(eq(cards.id, id)).get()
    const prevCol = prev?.column
    const updated = db.update(cards)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ ...extraData, column, position, updatedAt: new Date().toISOString() } as any)
      .where(eq(cards.id, id))
      .returning().get()
    const cols = prevCol && prevCol !== column ? [prevCol, column] : [column]
    this.connMgr.broadcast({ type: 'card:updated', data: updated as Card }, ...cols)
    return updated as Card
  }

  deleteCard(id: number): void {
    const card = db.select().from(cards).where(eq(cards.id, id)).get()
    if (!card) return
    db.delete(cards).where(eq(cards.id, id)).run()
    this.connMgr.broadcast({ type: 'card:deleted', data: { id } }, card.column)
  }

  // --- Projects ---

  listProjects(): Project[] {
    return db.select().from(projects).all()
  }

  createProject(data: Record<string, unknown>): Project {
    if (!data.color) {
      const used = db.select({ color: projects.color }).from(projects).all()
        .map(p => p.color).filter(Boolean)
      data.color = NEON_COLORS.find(c => !used.includes(c)) ?? NEON_COLORS[0]
    }
    const created = db.insert(projects).values({
      ...data,
      createdAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).returning().get()
    this.connMgr.broadcast({ type: 'project:updated', data: created as Project })
    return created as Project
  }

  updateProject(id: number, data: Record<string, unknown>): Project {
    const updated = db.update(projects)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(data as any)
      .where(eq(projects.id, id))
      .returning().get()
    this.connMgr.broadcast({ type: 'project:updated', data: updated as Project })
    return updated as Project
  }

  deleteProject(id: number): void {
    db.delete(projects).where(eq(projects.id, id)).run()
    this.connMgr.broadcast({ type: 'project:deleted', data: { id } })
  }
}
