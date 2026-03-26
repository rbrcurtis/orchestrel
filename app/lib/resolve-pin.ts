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
 * Sticky behavior: if a slot was previously displaying a card that is still
 * eligible (same project, still review/running, not excluded), it stays in
 * that slot. New cards fill remaining slots from the ranked pool.
 *
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Active running (queuePosition == null) — newest updatedAt first
 *   3. Queued running — queuePosition ascending, newest updatedAt as tiebreak
 */
export function resolvePinnedCards(
  slots: SlotState[],
  cards: Card[],
  currentDisplayed: Map<number, number> = new Map(),
): Map<number, number> {
  // Build exclusion set: cards already stored in any slot
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }

  // Index cards by id for fast lookup
  const cardById = new Map<number, Card>();
  for (const c of cards) cardById.set(c.id, c);

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

    // Sticky pass: keep currently-displayed cards that are still eligible.
    // Exception: release running cards when review cards are waiting,
    // so the slot switches to the next review card after a prompt is sent.
    const hasReviewCards = eligible.some((c) => c.column === 'review');
    const stickyCardIds = new Set<number>();
    const unfilledSlots: number[] = [];
    for (const idx of slotIndices) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null) {
        const card = cardById.get(prevCardId);
        if (
          card &&
          card.projectId === projectId &&
          (card.column === 'review' || card.column === 'running') &&
          !usedCardIds.has(card.id)
        ) {
          // Release running cards when review cards are available
          if (card.column === 'running' && hasReviewCards) {
            unfilledSlots.push(idx);
            continue;
          }
          result.set(idx, prevCardId);
          stickyCardIds.add(prevCardId);
          continue;
        }
      }
      unfilledSlots.push(idx);
    }

    // Rank remaining eligible cards (excluding sticky ones)
    const remaining = eligible.filter((c) => !stickyCardIds.has(c.id));

    const review = remaining
      .filter((c) => c.column === 'review')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const activeRunning = remaining
      .filter((c) => c.column === 'running' && c.queuePosition == null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const queuedRunning = remaining
      .filter((c) => c.column === 'running' && c.queuePosition != null)
      .sort((a, b) => {
        const qDiff = (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
        return qDiff !== 0 ? qDiff : b.updatedAt.localeCompare(a.updatedAt);
      });

    const ranked = [...review, ...activeRunning, ...queuedRunning];

    // Distribute remaining ranked cards to unfilled slots
    for (let i = 0; i < unfilledSlots.length; i++) {
      if (i < ranked.length) result.set(unfilledSlots[i], ranked[i].id);
    }
  }

  return result;
}
