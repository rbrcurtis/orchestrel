import type { Card } from '../../src/shared/ws-protocol';

export type SlotState =
  | { type: 'pinned'; projectId: number; cardId?: number }
  | { type: 'manual'; cardId: number }
  | { type: 'empty' };

/**
 * Resolve which card each pinned slot should display.
 *
 * Returns Map<slotIndex, cardId> for every pinned slot with a qualifying card.
 * Pinned slots with no qualifying card are absent from the map.
 *
 * Cards already visible in any slot (manual or pinned override) are excluded.
 *
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Active running (queuePosition == null) — newest updatedAt first
 *   3. Queued running — queuePosition ascending, newest updatedAt as tiebreak
 */
export function resolvePinnedCards(slots: SlotState[], cards: Card[]): Map<number, number> {
  // Build exclusion set: cards already stored in any slot
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }

  // Group pinned slot indices by projectId
  const projectSlots = new Map<number, number[]>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.type !== 'pinned') continue;
    const existing = projectSlots.get(slot.projectId);
    if (existing) existing.push(i);
    else projectSlots.set(slot.projectId, [i]);
  }

  const result = new Map<number, number>();

  for (const [projectId, slotIndices] of projectSlots) {
    const eligible = cards.filter(
      (c) => c.projectId === projectId && (c.column === 'review' || c.column === 'running') && !usedCardIds.has(c.id),
    );

    const review = eligible.filter((c) => c.column === 'review').sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const activeRunning = eligible
      .filter((c) => c.column === 'running' && c.queuePosition == null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const queuedRunning = eligible
      .filter((c) => c.column === 'running' && c.queuePosition != null)
      .sort((a, b) => {
        const qDiff = (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
        return qDiff !== 0 ? qDiff : b.updatedAt.localeCompare(a.updatedAt);
      });

    const ranked = [...review, ...activeRunning, ...queuedRunning];

    for (let i = 0; i < slotIndices.length; i++) {
      if (i < ranked.length) result.set(slotIndices[i], ranked[i].id);
    }
  }

  return result;
}
